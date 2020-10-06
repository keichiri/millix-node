import config, {SHARD_ZERO_NAME} from '../core/config/config';
import fs from 'fs';
import mutex from '../core/mutex';
import cryptoRandomString from 'crypto-random-string';
import os from 'os';
import wallet from '../core/wallet/wallet';
import console from '../core/console';
import path from 'path';
import async from 'async';
import {Address, API, Config, Job, Keychain, Node, Schema, Shard as ShardRepository, Wallet, Trigger} from './repositories/repositories';
import Shard from './shard';
import _ from 'lodash';


export class Database {
    static ID_CHARACTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

    constructor() {
        this.databaseMillix     = null;
        this.databaseJobEngine  = null;
        this.databaseRootFolder = null;
        this.repositories       = {};
        this.knownShards        = new Set();
        this.shards             = {};
        this.shardRepositories  = new Set([
            'audit_point',
            'transaction',
            'audit_verification'
        ]);
    }

    static generateID(length) {
        return cryptoRandomString({
            length,
            characters: Database.ID_CHARACTERS
        });
    }

    getRootFolder() {
        return this.databaseRootFolder;
    }

    static buildQuery(sql, where, orderBy, limit, shardID) {
        let parameters = [];
        if (where) {
            _.each(_.keys(where), key => {
                if (where[key] === undefined) {
                    return;
                }

                if (parameters.length > 0) {
                    sql += ' AND ';
                }
                else {
                    sql += ' WHERE ';
                }

                if (key.endsWith('_begin') || key.endsWith('_min')) {
                    sql += `${key.substring(0, key.lastIndexOf('_'))} >= ?`;
                }
                else if (key.endsWith('_end') || key.endsWith('_max')) {
                    sql += `${key.substring(0, key.lastIndexOf('_'))} <= ?`;
                }
                else {
                    sql += `${key} = ?`;
                }

                parameters.push(where[key]);
            });
        }

        if (shardID) {
            if (parameters.length === 0) {
                sql += ' WHERE shard_id = ?';
            }
            else {
                sql += ' AND shard_id = ?';
            }
            parameters.push(shardID);
        }

        if (orderBy) {
            sql += ' ORDER BY ' + orderBy;
        }

        if (limit) {
            sql += ' LIMIT ?';
            parameters.push(limit);
        }
        return {
            sql,
            parameters
        };
    }

    static buildUpdate(sql, set, where) {
        let parameters = [];
        let first      = true;
        _.each(_.keys(set), key => {
            if (set[key] === undefined) {
                return;
            }

            if (!first) {
                sql += ', ';
            }
            else {
                sql += ' SET ';
                first = false;
            }

            sql += `${key} = ?`;

            parameters.push(set[key]);
        });
        first = true;
        if (where) {
            _.each(_.keys(where), key => {
                if (where[key] === undefined) {
                    return;
                }

                if (!first) {
                    sql += ' AND ';
                }
                else {
                    sql += ' WHERE ';
                    first = false;
                }

                if (key.endsWith('_begin') || key.endsWith('_min')) {
                    sql += `${key.substring(0, key.lastIndexOf('_'))} >= ?`;
                }
                else if (key.endsWith('_end') || key.endsWith('_max')) {
                    sql += `${key.substring(0, key.lastIndexOf('_'))} <= ?`;
                }
                else {
                    sql += `${key} = ?`;
                }

                parameters.push(where[key]);
            });
        }

        return {
            sql,
            parameters
        };
    }

    _initializeMillixSqlite3() {
        return new Promise(resolve => {
            const sqlite3                       = require('sqlite3');
            sqlite3.Database.prototype.runAsync = function(sql, ...params) {
                return new Promise((resolve, reject) => {
                    this.run(sql, params, function(err) {
                        if (err) {
                            return reject(err);
                        }
                        resolve(this);
                    });
                });
            };

            this.databaseRootFolder = path.join(os.homedir(), config.DATABASE_CONNECTION.FOLDER);
            if (!fs.existsSync(this.databaseRootFolder)) {
                fs.mkdirSync(path.join(this.databaseRootFolder));
            }

            let dbFile = path.join(this.databaseRootFolder, config.DATABASE_CONNECTION.FILENAME_MILLIX);

            let doInitialize = false;
            if (!fs.existsSync(dbFile)) {
                doInitialize = true;
            }

            this.databaseMillix = new sqlite3.Database(dbFile, (err) => {
                if (err) {
                    throw Error(err.message);
                }

                console.log('Connected to the millix database.');

                if (doInitialize) {
                    console.log('Initializing database');
                    fs.readFile(config.DATABASE_CONNECTION.SCRIPT_INIT_MILLIX, 'utf8', (err, data) => {
                        if (err) {
                            throw Error(err.message);
                        }
                        this.databaseMillix.exec(data, (err) => {
                            if (err) {
                                return console.log(err.message);
                            }
                            console.log('Database initialized');

                            resolve();
                        });
                    });
                }
                else {
                    resolve();
                }

            });
        });
    }

    _initializeJobEngineSqlite3() {
        return new Promise(resolve => {
            const sqlite3 = require('sqlite3');

            if (!fs.existsSync(path.join(os.homedir(), config.DATABASE_CONNECTION.FOLDER))) {
                fs.mkdirSync(path.join(os.homedir(), config.DATABASE_CONNECTION.FOLDER));
            }

            let dbFile = path.join(os.homedir(), config.DATABASE_CONNECTION.FOLDER + config.DATABASE_CONNECTION.FILENAME_JOB_ENGINE);

            let doInitialize = false;
            if (!fs.existsSync(dbFile)) {
                doInitialize = true;
            }

            this.databaseJobEngine = new sqlite3.Database(dbFile, (err) => {
                if (err) {
                    throw Error(err.message);
                }

                console.log('Connected to the job engine database.');

                if (doInitialize) {
                    console.log('Initializing database');
                    fs.readFile(config.DATABASE_CONNECTION.SCRIPT_INIT_MILLIX_JOB_ENGINE, 'utf8', (err, data) => {
                        if (err) {
                            throw Error(err.message);
                        }
                        this.databaseJobEngine.exec(data, function(err) {
                            if (err) {
                                return console.log(err.message);
                            }
                            console.log('Database initialized');

                            resolve();
                        });
                    });
                }
                else {
                    resolve();
                }

            });
        });
    }

    addShard(shard, updateTables) {
        const dbShard = new Shard(shard.schema_path + shard.schema_name, shard.shard_id);
        return dbShard.initialize()
                      .then(() => {
                          this.shards[shard.shard_id] = dbShard;
                          this.knownShards.add(shard.shard_id);
                          if (updateTables) {
                              const transactionRepository = this.shards[shard.shard_id].getRepository('transaction');
                              transactionRepository.setAddressRepository(this.repositories['address']);
                          }
                      });
    }

    _initializeShards() {
        const shardRepository      = new ShardRepository(this.databaseMillix);
        this.repositories['shard'] = shardRepository;
        return shardRepository.listShard()
                              .then((shardList) => {
                                  return new Promise(resolve => {
                                      async.eachSeries(shardList, (shard, callback) => {
                                          if (shard.is_required) {
                                              this.addShard(shard).then(() => callback());
                                          }
                                          else {
                                              this.addKnownShard(shard.shard_id);
                                              callback();
                                          }
                                      }, () => resolve());
                                  });
                              });
    }

    _initializeTables() {
        this.repositories['node']     = new Node(this.databaseMillix);
        this.repositories['keychain'] = new Keychain(this.databaseMillix);
        this.repositories['config']   = new Config(this.databaseMillix);
        this.repositories['wallet']   = new Wallet(this.databaseMillix);
        this.repositories['address']  = new Address(this.databaseMillix);
        this.repositories['job']      = new Job(this.databaseJobEngine);
        this.repositories['api']      = new API(this.databaseMillix);
        this.repositories['trigger']  = new Trigger(this.databaseMillix);

        // initialize shard 0 (root)
        const dbShard            = new Shard();
        dbShard.database         = this.databaseMillix;
        dbShard.database.shardID = SHARD_ZERO_NAME;
        dbShard._initializeTables().then(_ => _);
        this.shards[SHARD_ZERO_NAME] = dbShard;
        this.knownShards.add(SHARD_ZERO_NAME);

        _.each(_.keys(this.shards), shard => {
            const transactionRepository = this.shards[shard].getRepository('transaction');
            transactionRepository.setAddressRepository(this.repositories['address']);
        });

        return this.repositories['address'].loadAddressVersion();
    }

    getShard(shardID) {
        return this.shards[shardID];
    }

    addKnownShard(shardID) {
        this.knownShards.add(shardID);
    }

    shardExists(shardID) {
        return this.knownShards.has(shardID);
    }

    getRepository(repositoryName, shardID) {
        try {
            if (this.shardRepositories.has(repositoryName)) {
                if (shardID) {
                    return this.shards[shardID].getRepository(repositoryName);
                }
                return this.shards[SHARD_ZERO_NAME].getRepository(repositoryName);
            }
            return this.repositories[repositoryName];
        }
        catch (e) {
            console.log('[database] repository not found');
            return null;
        }
    }

    firstShardZeroORShardRepository(repositoryName, shardID, func) {
        return new Promise(resolve => {
            async.eachSeries([
                SHARD_ZERO_NAME,
                shardID
            ], (shardID, callback) => {
                const repository = this.getRepository(repositoryName, shardID);
                if (repository) {
                    func(repository)
                        .then((data) => callback(data))
                        .catch(() => callback());
                }
                else {
                    callback();
                }
            }, (data) => resolve(data));
        });
    }

    applyShardZeroAndShardRepository(repositoryName, shardID, func) {
        return new Promise(resolve => {
            async.eachSeries([
                SHARD_ZERO_NAME,
                shardID
            ], (shardID, callback) => {
                const repository = this.getRepository(repositoryName, shardID);
                if (repository) {
                    func(repository)
                        .then(() => callback())
                        .catch(() => callback());
                }
                else {
                    callback();
                }
            }, () => resolve());
        });
    }

    applyShards(func, orderBy, limit, shardID) {
        return new Promise(resolve => {
            async.waterfall([
                callback => {
                    if (shardID) {
                        return callback(null, [shardID]);
                    }
                    else {
                        return callback(null, _.keys(this.shards));
                    }
                },
                (shardList, callback) => {
                    async.mapSeries([SHARD_ZERO_NAME].concat(_.without(shardList, SHARD_ZERO_NAME)), (dbShardID, mapCallback) => {
                        func(dbShardID).then(result => mapCallback(null, result)).catch(() => mapCallback(null, []));
                    }, (error, data) => {
                        if (data) {
                            data = Array.prototype.concat.apply([], data);
                        }
                        else {
                            data = [];
                        }

                        if (orderBy) {
                            const regExp = /^(?<column>\w+) (?<order>asc|desc)$/.exec(orderBy);
                            if (regExp && regExp.groups && regExp.groups.column && regExp.groups.order) {
                                data = _.orderBy(data, regExp.groups.column, regExp.groups.order);
                            }
                        }

                        if (limit !== undefined) {
                            data = data.slice(0, limit);
                        }

                        callback(null, data);
                    });
                }
            ], (error, data) => {
                resolve(data);
            });
        });
    }

    firstShards(func) {
        return new Promise((resolve) => {
            async.waterfall([
                callback => {
                    return callback(null, _.shuffle(_.keys(this.shards)));
                },
                (shardList, callback) => {
                    async.eachSeries([SHARD_ZERO_NAME].concat(_.without(shardList, SHARD_ZERO_NAME)), (dbShardID, mapCallback) => {
                        func(dbShardID)
                            .then(result => mapCallback(result))
                            .catch(() => mapCallback());
                    }, (data) => callback(data));
                }
            ], (data) => {
                resolve(data);
            });
        });
    }

    runWallCheckpoint() {
        return new Promise(resolve => {
            mutex.lock(['transaction'], (unlock) => {
                console.log('[database] locking for wal checkpoint');
                this.databaseMillix.run('PRAGMA wal_checkpoint(TRUNCATE)', function(err) {
                    if (err) {
                        console.log('[database] wal checkpoint error', err);
                    }
                    else {
                        console.log('[database] wal checkpoint success');
                    }
                    unlock();
                    resolve();
                });
            });
        });
    }

    runVacuum() {
        return new Promise(resolve => {
            mutex.lock(['transaction'], (unlock) => {
                console.log('[database] locking for vacuum');
                this.databaseMillix.run('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);', function(err) {
                    if (err) {
                        console.log('[database] vacuum error', err);
                    }
                    else {
                        console.log('[database] vacuum success');
                    }
                    unlock();
                    resolve();
                });
            });
        });
    }

    _migrateTables() {
        const schema                = new Schema(this.databaseMillix);
        this.repositories['schema'] = schema;
        console.log('[database] check schema version');
        return new Promise(resolve => {
            schema.getVersion()
                  .then(version => {
                      if (parseInt(version) < parseInt(config.DATABASE_CONNECTION.SCHEMA_VERSION)) {
                          const newVersion = parseInt(version) + 1;
                          console.log('[database] migrating schema from version', version, ' to version ', newVersion);
                          schema.migrate(newVersion, config.DATABASE_CONNECTION.SCRIPT_MIGRATION_DIR)
                                .then(() => this._migrateTables())
                                .then(() => resolve());
                      }
                      else {
                          console.log('[database] current schema version is ', version);
                          resolve();
                      }
                  })
                  .catch((err) => {
                      if (err.message.indexOf('no such table') > -1) {
                          console.log('[database] migrating to version 1');
                          schema.migrate(1, config.DATABASE_CONNECTION.SCRIPT_MIGRATION_DIR)
                                .then(() => this._migrateTables())
                                .then(() => resolve());
                      }
                  });
        });
    }

    initialize() {
        if (config.DATABASE_ENGINE === 'sqlite') {
            return this._initializeMillixSqlite3()
                       .then(() => this._initializeJobEngineSqlite3())
                       .then(() => this._migrateTables())
                       .then(() => this._initializeShards())
                       .then(() => this._initializeTables());
        }
        return Promise.resolve();
    }

    close() {
        return new Promise(resolve => {
            async.waterfall([
                (callback) => {
                    if (this.databaseMillix) {
                        this.databaseMillix.close((err) => {
                            if (err) {
                                console.error(err.message);
                            }
                            console.log('Close the millix database connection.');
                            callback();
                        });
                    }
                    else {
                        callback();
                    }
                },
                (callback) => {
                    if (this.databaseJobEngine) {
                        this.databaseJobEngine.close((err) => {
                            if (err) {
                                console.error(err.message);
                            }
                            console.log('Close the job engine database connection.');
                            callback();
                        });
                    }
                    else {
                        callback();
                    }
                }
            ], () => resolve());
        });
    }
}


export default new Database();
