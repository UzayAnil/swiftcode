'use strict';

var util = require('util');
var mongoose = require('mongoose');
var Schema = mongoose.Schema;
var bcrypt = require('bcrypt');
var _ = require('lodash');
var moment = require('moment');
var hljs = require('highlight.js');
var cheerio = require('cheerio');

var enet = require('./eventnet');

// Constant configs
var SALT_WORK_FACTOR = 10;
var ANONYMOUS_ID_MIN = 1000;
var ANONYMOUS_ID_MAX = 10000;
var GAME_TIME_JOIN_CUTOFF_MS = 5000;
var GAME_SINGLE_PLAYER_WAIT_TIME = 5;
var GAME_MULTI_PLAYER_WAIT_TIME = 20;
var GAME_DEFAULT_MAX_PLAYERS = 4;
var CHARACTERS_PER_WORD = 5;
var MILLISECONDS_PER_MINUTE = 60000;
var STATISTICS_VALIDATION_THRESHOLD_MS = 100;

var NON_TYPEABLES = ['comment', 'template_comment', 'diff', 'javadoc', 'phpdoc'];
var NON_TYPEABLE_CLASSES = _.map(NON_TYPEABLES, function(c) { return '.' + c; }).join(',');

// Anonymous ID
var anonymousId = 0;

var UserSchema = new Schema({
    username: { type: String, required: true, index: { unique: true } },
    password: { type: String },
    isAnonymous: { type: Boolean, default: false },
    isAdmin: { type: Boolean, default: false },
    bestTime: { type: Number },
    bestSpeed: { type: Number },
    averageTime: { type: Number, default: 0 },
    averageSpeed: { type: Number, default: 0 },
    totalGames: { type: Number, default: 0 },
    totalMultiplayerGames: { type: Number, default: 0 },
    gamesWon: { type: Number, default: 0 },
    isAllowedIngame: { type: Boolean, default: false },
    ingameAction: { type: String },
    ingameArgs: { type: Schema.Types.Mixed },
    currentGame: { type: Schema.ObjectId }
}, { usePushEach: true });

// TODO: Look into using async library to avoid the spaghetti nesting
UserSchema.pre('save', function(next) {
    var user = this;

    if (!user.isModified('password')) {
        return next();
    }
    bcrypt.genSalt(SALT_WORK_FACTOR, function(err, salt) {
        if (err) {
            util.log(err);
            return next(err);
        }
        bcrypt.hash(user.password, salt, function(err, hash) {
            if (err) {
                util.log(err);
                return next(err);
            }
            user.password = hash;
            next();
        });
    });
});

UserSchema.methods.comparePassword = function(candidate, callback) {
    bcrypt.compare(candidate, this.password, function(err, isMatch) {
        if (err) {
            util.log(err);
            return callback(err);
        }
        return callback(null, isMatch);
    });
};

UserSchema.methods.prepareIngameAction = function(action, args, callback) {
    var user = this;

    user.isAllowedIngame = true;
    user.ingameAction = action;
    user.ingameArgs = args;
    user.save(callback);
};

UserSchema.methods.performIngameAction = function(callback) {
    var user = this;

    if (user.ingameAction === 'join') {
        Game.findById(user.ingameArgs.game, function(err, game) {
            if (err) {
                util.log(err);
                util.log('games:join error');
                return callback(err, false);
            }
            user.joinGame(game, function(err, success, game) {
                if (err) {
                    return callback(err, false);
                }
                return callback(err, success, game);
            });
        });
    } else if (user.ingameAction === 'createnew') {
        Lang.findOne({ key: user.ingameArgs.lang }, function(err, lang) {
            if (lang) {
                user.createGame({
                    lang: lang.key,
                    langName: lang.name,
                    exercise: lang.randomExercise(),
                    isSinglePlayer: user.ingameArgs.isSinglePlayer
                }, function(err, success, game) {
                    if (err) {
                        return callback(err, false);
                    }
                    return callback(err, success, game);
                });
            } else {
                util.log('No such game type: ' + user.ingameArgs.lang);
                return callback('No such game type: ' + user.ingameArgs.lang, false);
            }
        });
    } else {
        return callback('No such action type: ' + user.ingameAction, false);
    }
};

UserSchema.methods.joinGame = function(game, callback) {
    var user = this;

    var error = game.getJoinError(user);
    if (error) {
        return callback(error, false);
    }

    user.currentGame = game._id;
    game.addPlayer(user, function(err) {
        if (err) {
            util.log(err);
            return callback('error joining game', false);
        }
        user.save(function(err) {
            if (err) {
                util.log(err);
                return callback('error saving user', false);
            }
            enet.emit('users:update', user);
            return callback(null, true, game);
        });
    });
};

UserSchema.methods.createGame = function(opts, callback) {
    var user = this;

    // User cannot create a game when he is already in one
    if (user.currentGame) {
        return callback('you are already inside another game!', false);
    }

    var game = new Game();
    _.extend(game, opts);

    game.creator = user._id;
    if (game.isSinglePlayer) {
        game.beginSinglePlayer();
    } else {
        game.beginMultiPlayer();
    }

    return user.joinGame(game, callback);
};

UserSchema.methods.quitCurrentGame = function(callback) {
    callback = callback || function() {};

    var user = this;
    if (user.currentGame) {
        Game.findById(user.currentGame, function(err, game) {
            if (err) {
                util.log(err);
                return callback('error retrieving game');
            }
            if (game) {
                game.removePlayer(user, function(err) {
                    if (err) {
                        util.log(err);
                        return callback(err);
                    }
                    user.currentGame = undefined;
                    user.save(function(err) {
                        if (err) {
                            util.log(err);
                            return callback('error saving user');
                        }
                        return callback(null, game);
                    });
                });
            }
        });
    } else {
        return callback();
    }
};

UserSchema.methods.updateStatistics = function(stats, game, callback) {
    var user = this;
    user.bestTime = Math.min(user.bestTime || Infinity, stats.time || Infinity);
    user.bestSpeed = Math.max(user.bestSpeed || 0, stats.speed || 0);
    user.totalGames += 1;
    if (!game.isSinglePlayer) {
        user.totalMultiplayerGames += 1;
    }
    if (game.winner === user.id) {
        user.gamesWon += 1;
    }
    user.averageTime = (user.averageTime * (user.totalGames - 1) + stats.time) / user.totalGames;
    user.averageSpeed = (user.averageSpeed * (user.totalGames - 1) + stats.speed) / user.totalGames;

    user.save(function(err) {
        if (err) {
            util.log(err);
            return callback('error saving user');
        }
        return callback(null, user);
    });
};

UserSchema.statics.resetCurrentGames = function() {
    var users = this;
    users.update({
        currentGame: { $exists: true }
    }, {
        $unset: { currentGame: true }
    }, {
        multi: true
    }, function(err) {
        if (err) {
            util.log(err);
        }
        util.log('users reset');
    });
};

UserSchema.statics.resetAnonymous = function() {
    var users = this;
    users.remove({ isAnonymous: true }, function(err) {
        if (err) {
            util.log(err);
        }
        util.log('anonymous reset');
    });
};

UserSchema.statics.setupAnonymous = function() {
    anonymousId = Math.floor(Math.random() *
        (ANONYMOUS_ID_MAX - ANONYMOUS_ID_MIN)) + ANONYMOUS_ID_MIN;
};

UserSchema.statics.generateAnonymousUsername = function() {
    anonymousId++;
    return 'player' + anonymousId;
};

var LangSchema = new Schema({
    key: { type: String, unique: true },
    name: { type: String },
    order: { type: Number },
    exercises: [Schema.ObjectId]
}, { usePushEach: true });

LangSchema.methods.randomExercise = function() {
    return this.exercises[Math.floor(Math.random() * this.exercises.length)];
};

var ProjectSchema = new Schema({
    key: { type: String, unique: true },
    name: { type: String },
    url: { type: String },
    codeUrl: { type: String },
    licenseUrl: { type: String },
    lang: { type: String },
    langName: { type: String }
}, { usePushEach: true });

var ExerciseSchema = new Schema({
    isInitialized: { type: Boolean },
    lang: { type: String },
    project: { type: Schema.ObjectId },
    projectName: { type: String },
    exerciseName: { type: String },
    code: { type: String },
    highlitCode: { type: String },
    commentlessCode: { type: String },
    typeableCode: { type: String },
    typeables: { type: Number },
    highlightingErrorReports: { type: Number, default: 0 }
}, { usePushEach: true });

ExerciseSchema.pre('save', function(next) {
    var exercise = this;
    if (!exercise.isInitialized) {
        exercise.initialize();
    }
    next();
});

ExerciseSchema.methods.initialize = function() {
    var exercise = this;
    exercise.normalizeNewlines();
    exercise.tabsToSpaces();
    exercise.countTypeables();
    exercise.isInitialized = true;
};

ExerciseSchema.methods.normalizeNewlines = function() {
    var exercise = this;
    exercise.code = exercise.code.replace(/\r\n|\n\r|\r|\n/g, '\n');
};

ExerciseSchema.methods.tabsToSpaces = function() {
    var exercise = this;
    exercise.code = exercise.code.replace(/\t/g, '    ');
};

ExerciseSchema.methods.countTypeables = function() {
    var exercise = this;
    exercise.code = exercise.code.replace(/(^\n+)|(\s+$)/g, '') + '\n';

    // Highlight.js doesn't always get it right with autodetection
    var highlight = (exercise.lang in hljs.LANGUAGES) ?
                    hljs.highlight(exercise.lang, exercise.code, true) :
                    hljs.highlightAuto(exercise.code);

    exercise.highlitCode = highlight.value;

    // Remove comments because we don't want the player to type out
    // a 500 word explanation for some obscure piece of code
    var $ = cheerio.load(exercise.highlitCode);
    $(NON_TYPEABLE_CLASSES).remove();

    exercise.commentlessCode = $.root().text();
    exercise.typeableCode = exercise.commentlessCode.replace(/(^[ \t]+)|([ \t]+$)/gm, '')
                            .replace(/\n+/g, '\n').trim() + '\n';
    exercise.typeables = exercise.typeableCode.length;
};

var GameSchema = new Schema({
    lang: { type: String, required: true },
    langName: { type: String },
    exercise: { type: Schema.ObjectId },
    isSinglePlayer: { type: Boolean, default: false },
    numPlayers: { type: Number, min: 0, default: 0 },
    maxPlayers: { type: Number, min: 0, default: GAME_DEFAULT_MAX_PLAYERS },
    status: { type: String },
    statusText: { type: String },
    isJoinable: { type: Boolean, default: true },
    isComplete: { type: Boolean, default: false },
    isViewable: { type: Boolean, default: true },
    starting: { type: Boolean, default: false },
    started: { type: Boolean, default: false },
    startTime: { type: Date },
    creator: { type: Schema.ObjectId },
    winner: { type: Schema.ObjectId },
    winnerTime: { type: Number, min: 0 },
    winnerSpeed: { type: Number, min: 0 },
    players: [Schema.ObjectId],
    playerNames: [String],
    startingPlayers: [Schema.ObjectId],
    wasReset: { type: Boolean, default: false }
}, { usePushEach: true });

/**
 * Server-side object that holds timeoutIds for the
 * timing operations of SwiftCODE.
 */
var gameTimeouts = {
    create: function(g, t, f) {
        var self = this;
        if (g in self) {
            clearTimeout(self[g]);
        }
        self[g] = setTimeout(function() {
            delete self[g];
            f();
        }, t);
    },
    remove: function(g) {
        if (g in this) {
            clearTimeout(this[g]);
            delete this[g];
        }
    }
};

GameSchema.methods.beginSinglePlayer = function() {
    var game = this;
    game.setStatus('waiting');
    game.isJoinable = false;
    game.isViewable = false;
    game.isComplete = false;
    game.maxPlayers = 1;
};

GameSchema.methods.beginMultiPlayer = function() {
    var game = this;
    game.setStatus('waiting');
    game.isJoinable = true;
    game.isViewable = true;
    game.isComplete = false;
    game.isSinglePlayer = false;
};

GameSchema.methods.updateGameState = function(callback) {
    callback = callback || function() {};

    var game = this;
    game.deduceGameState();

    var wasNew = game.isNew;
    var wasModified = game.isModified();
    game.save(function(err, game) {
        if (err) {
            util.log(err);
            return callback('error saving user');
        }
        if (wasNew) {
            enet.emit('games:new', game);
        } else if (game.isComplete) {
            enet.emit('games:remove', game);
        } else if (wasModified) {
            enet.emit('games:update', game);
        }
        return callback(null, game);
    });
};

GameSchema.methods.deduceGameState = function() {
    var game = this;

    if (game.numPlayers === 0) {
        return game.finish();
    }
    if (game.numPlayers === game.maxPlayers) {
        game.isJoinable = false;
    }

    if (game.isSinglePlayer) {
        game.deduceGameStateSinglePlayer();
    } else {
        game.deduceGameStateMultiPlayer();
    }
};

GameSchema.methods.deduceGameStateSinglePlayer = function() {
    var game = this;
    if (!game.started) {
        if (!game.starting) {
            game.starting = true;
            game.startTime = moment().add(GAME_SINGLE_PLAYER_WAIT_TIME, 'seconds').toDate();
        }
        game.setupTiming();
    }
};

GameSchema.methods.deduceGameStateMultiPlayer = function() {
    var game = this;

    if (!game.started) {
        if (game.starting) {
            // Starting interrupt condition
            if (game.numPlayers < 2) {
                game.starting = false;
                game.startTime = undefined;
                game.isJoinable = true;
                gameTimeouts.remove(game.id);
            } else {
                game.setupTiming();
            }
        } else {
            if (game.numPlayers > 1) {
                game.starting = true;
                game.startTime = moment().add(GAME_MULTI_PLAYER_WAIT_TIME, 'seconds').toDate();
                game.setupTiming();
            }
        }
    }
};

GameSchema.methods.setupTiming = function() {
    var game = this;
    var timeLeft = moment(game.startTime).diff(moment());
    if (game.isJoinable) {
        if (timeLeft > GAME_TIME_JOIN_CUTOFF_MS) {
            gameTimeouts.create(game.id, timeLeft - GAME_TIME_JOIN_CUTOFF_MS + 1, function() {
                Game.findById(game.id, function(err, game) {
                    if (err) {
                        util.log(err);
                    }
                    game.isJoinable = false;
                    game.updateGameState();
                });
            });
        } else {
            game.isJoinable = false;
        }
    } else {
        if (timeLeft > 0) {
            gameTimeouts.create(game.id, timeLeft + 1, function() {
                Game.findById(game.id, function(err, game) {
                    if (err) {
                        util.log(err);
                    }
                    game.start();
                    game.updateGameState();
                });
            });
        } else {
            game.start();
        }
    }
};

GameSchema.methods.setStatus = function(status) {
    var bindings = {
        'waiting': 'Waiting',
        'ingame': 'In game'
    };
    this.status = status;
    this.statusText = bindings[status];
};

GameSchema.methods.getJoinError = function(player) {
    var game = this;
    if (!game.isJoinable && !game.isSinglePlayer) {
        return 'this game is full, or has been removed';
    }
    var playerIds = _.map(game.players, function(p) {
        return p.toHexString();
    });
    if (_.contains(playerIds, player.id)) {
        return 'you are already inside another game!';
    }
    return undefined;
};

GameSchema.methods.addPlayer = function(player, callback) {
    var game = this;

    game.players.push(player._id);
    game.playerNames.push(player.username);
    game.numPlayers += 1;
    game.updateGameState(callback);
};

GameSchema.methods.removePlayer = function(player, callback) {
    var game = this;
    game.players.remove(player._id);
    game.playerNames.remove(player.username);
    game.numPlayers = game.numPlayers <= 0 ? 0 : game.numPlayers - 1;
    game.updateGameState(callback);
};

GameSchema.methods.start = function() {
    var game = this;
    game.started = true;
    game.startingPlayers = game.players.slice();
    game.setStatus('ingame');
    game.isJoinable = false;
};

GameSchema.methods.finish = function() {
    var game = this;
    game.isComplete = true;
    game.isViewable = false;
    game.isJoinable = false;
    gameTimeouts.remove(game.id);
};

GameSchema.methods.updateStatistics = function(stats, callback) {
    var game = this;
    if (game.winnerTime !== stats.time &&
        Math.min(game.winnerTime || Infinity, stats.time || Infinity) === stats.time) {

        game.winner = stats.player;
        game.winnerTime = stats.time;
        game.winnerSpeed = stats.speed;

        game.save(function(err) {
            if (err) {
                util.log(err);
                return callback('error saving game');
            }
            return callback(null, game);
        });
    } else {
        return callback(null, game);
    }
};

GameSchema.statics.resetIncomplete = function() {
    var games = this;
    games.update({
        $or: [{ isComplete: false }, { isViewable: true }]
    }, {
        isComplete: true,
        isViewable: false,
        numPlayers: 0,
        players: [],
        isJoinable: false,
        wasReset: true
    }, {
        multi: true
    }, function(err) {
        if (err) {
            util.log(err);
        }
        util.log('games reset');
    });
};

var StatsSchema = new Schema({
    player: { type: Schema.ObjectId, required: true },
    game: { type: Schema.ObjectId, required: true },
    time: { type: Number },
    speed: { type: Number },
    typeables: { type: Number },
    keystrokes: { type: Number },
    percentUnproductive: { type: Number },
    mistakes: { type: Number }
}, { usePushEach: true });

StatsSchema.methods.updateStatistics = function(callback) {
    var stats = this;

    User.findById(stats.player, function(err, user) {
        if (err) {
            util.log(err);
            return callback(err);
        }
        Game.findById(stats.game, function(err, game) {
            if (err) {
                util.log(err);
                return callback(err);
            }
            if (game) {
                Exercise.findById(game.exercise, function(err, exercise) {
                    if (err) {
                        util.log(err);
                        return callback(err);
                    }

                    // Clamp input to the real time difference, if it is beyond
                    // a threshold
                    var realTime = moment().diff(game.startTime, 'milliseconds');
                    if (Math.abs(realTime - stats.time) > STATISTICS_VALIDATION_THRESHOLD_MS) {
                        stats.time = realTime;
                    }

                    stats.typeables = exercise.typeables;
                    stats.speed = (stats.typeables / CHARACTERS_PER_WORD) *
                                  (1 / (stats.time / MILLISECONDS_PER_MINUTE));
                    stats.percentUnproductive = 1 - stats.typeables / stats.keystrokes;

                    stats.save(function(err) {
                        if (err) {
                            util.log(err);
                        }
                    });
                    game.updateStatistics(stats, function(err) {
                        if (err) {
                            util.log(err);
                            return callback(err);
                        }
                        user.updateStatistics(stats, game, function(err) {
                            if (err) {
                                util.log(err);
                                return callback(err);
                            }
                            return callback(null, stats, user, game);
                        });
                    });
                });
            }
        });
    });
};

var User = mongoose.model('User', UserSchema);
var Lang = mongoose.model('Lang', LangSchema);
var Project = mongoose.model('Project', ProjectSchema);
var Exercise = mongoose.model('Exercise', ExerciseSchema);
var Game = mongoose.model('Game', GameSchema);
var Stats = mongoose.model('Stats', StatsSchema);

module.exports.User = User;
module.exports.Lang = Lang;
module.exports.Project = Project;
module.exports.Exercise = Exercise;
module.exports.Game = Game;
module.exports.Stats = Stats;

module.exports.NON_TYPEABLES = NON_TYPEABLES;
module.exports.NON_TYPEABLE_CLASSES = NON_TYPEABLE_CLASSES;
