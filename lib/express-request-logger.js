var _ = require('lodash');
var redis = require('redis');

/**
 * Default redis log TTLs per log type (pending, completed, slow, error).
 * @type {{p: number, c: number, s: number, e: number}}
 */
var defaultTtls = {
    p: 10 * 24 * 3600,
    c: 24 * 3600,
    s: 10 * 24 * 3600,
    e: 10 * 24 * 3600
};

/**
 * Default slow time query threshold in s.
 * @type {number}
 */
var defaultSlowTime = 1.0;

/**
 * Enables the request logger on the specified express app.
 * @param app
 *   An express app.
 * @param {object} options
 *   Options for logging:
 *   - {String} projectName
 *     The project name to log under.
 *   - {{p: int, e: int, c: int, s: int}} ttls
 *     The time to life of the logged requests, per type.
 *   - {Number} slowTime
 *     A request taking longer than this time (in s) is considered slow. Set to 0 for no slow logging.
 *   - {Boolean} forceLogging
 *     Force logging on non-supported environments.
 */
var configure = function(app, options) {
    if (!options.projectName || !_.isString(options.projectName) || !/^[a-z_\-\. ]+$/i.test(options.projectName)) {
        throw new Error("Please specify the project name to be used in the Redis cache.");
    }

    var redisConfig = [6379, "37.153.98.175"];

    // Check environment.
    var projectName = options.projectName;
    switch(process.env.NODE_ENV) {
        case "test":
            projectName += ".test";
            break;
        case "production":
        case "prod":
            projectName += ".prod";
            break;
        case "dev":
        case "backendDev":
            redisConfig = [6379, "localhost"];
            projectName += ".dev";
        default:
            break;
    }

    var prefix = "rLog:" + projectName + ":";

    // Provide the redis endpoint.
    var redisClient = null;
    var redisGetter = function() {
        if (!redisClient) {
            // Use the redis on test server as a fixed endpoint.
            redisClient = redis.createClient(redisConfig[0], redisConfig[1]);
        }
        return redisClient;
    };

    app.use(function(req, res, next) {
        if (req.method == 'OPTIONS' || req.method == 'HEAD') {
            // Do not log options requests.
            next();
            return;
        }

        var redis = redisGetter();

        /**
         * Returns the next auto incremented request index from Redis.
         * @return {number}
         */
        var getNextId = function(cb) {
            redis.incr(prefix + "id", cb);
        };

        // Keep track of the current type of the log so that we
        var currentType = null;

        /**
         * Writes the specified request log record.
         * @param record
         * @param [type]
         *   Either 'p' (pending), 'c' (completed), 's' (completed slow), 'e' (error).
         *   If not specified, the lastly set type is reused. In case of record.error, type 'e' is used.
         */
        var writeToRedis = function(record, type) {
            if (!type) {
                type = (record.info.error ? "e" : (currentType || "p"));
            }

            if (currentType && (currentType !== type)) {
                // Remove old log message.
                redis.del(prefix + currentType + ":" + record.id);
            }

            var key = prefix + type + ":" + record.id;

            var str;
            if (record.info.error) {
                if (_.isPlainObject(record.info.error)) {
                    str = JSON.stringify(record.info);
                } else {
                    // Prevent 'circular structure' error.
                    var origError = record.info.error;
                    record.info.error = "" + record.info.error;
                    str = JSON.stringify(record.info);
                    record.info.error = origError;
                }
            } else {
                str = JSON.stringify(record.info);
            }

            var expire = (options.ttl && options.ttl[type]) || defaultTtls[type];
            redis.setex(key, expire, str);

            currentType = type;
        };

        // Get id for log message.
        getNextId(function(err, id) {
            if (err) {
                // Ignore.
                console.error("[log]", "Redis next id error.", err);
                next();
                return;
            }

            // Remember log record so that information can be appended to it.
            res.rLog = {id: id, info: null};

            var props = ['url', 'method', 'body', 'language'];
            res.rLog.info = JSON.parse(JSON.stringify(_.pick(req, props)));
            res.rLog.info.time = (new Date()).getTime() / 1000;
            res.rLog.info.ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
            if (req.headers['referer']) {
                res.rLog.info.referer = req.headers['referer'];
            }
            if (req.headers['user-agent']) {
                res.rLog.info.userAgent = req.headers['user-agent'];
            }

            // Write request log to redis. Wait for a while to prevent unnecessary false (very short) pendings.
            res.rLog.writeTimeout = setTimeout(function() {
                writeToRedis(res.rLog, "p");
                res.rLog.writeTimeout = null;
            }, 4000);

            // Offer update function to propagate changes to the request log record directly.
            // This can be useful if other middleware or request handlers have more useful information on offer.
            res.rLog.update = function() {
                if (!res.rLog.writeTimeout) {
                    // If write timeout was set previously a write will follow shortly anyway.
                    writeToRedis(res.rLog);
                }
            };

            // Offer ignore function to not log some request.
            res.rLog.ignore = function() {
                if (res.rLog.writeTimeout) {
                    clearTimeout(res.rLog.writeTimeout);
                }
                delete res.rLog;
            };

            // Wait for response to finish.
            res.once('finish', function() {
                if (!res.rLog) {
                    // Request has been ignored.
                    return;
                }

                // Clear write timeout.
                clearTimeout(res.rLog.writeTimeout);
                res.rLog.writeTimeout = null;

                // Set duration.
                var now = (new Date()).getTime() / 1000;
                var delta = (now - res.rLog.info.time);
                res.rLog.info.duration = delta.toPrecision(3);

                var type = "c";
                if (res.rLog.info.error) {
                    // Error.
                    type = "e";
                } else {
                    var slowTime = (options.hasOwnProperty('slowTime') ? options.slowTime : defaultSlowTime);

                    if (slowTime && (delta > slowTime)) {
                        // Slow.
                        type = "s";
                    }
                }

                // Add response status.
                res.rLog.info.status = res.statusCode;

                writeToRedis(res.rLog, type);
            });

            next();
        });
    });
};

module.exports = {
    configure: configure
};