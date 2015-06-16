Express Request Logger
----------------------

Logs express pending, slow, error and completed requests to redis.

Use with redis module https://github.com/mranney/node_redis.

Usage:

1. Add the logger to the express application, preferably before any other middleware:

```javascript
require('express-request-logger').configure(
	app,
	getRedisClient,
	{projectName: "provisioningBackend"}
);

// Express config..
app.get('/', handleGet);
app.all('*',function(req,res){
	res.status(404).end();
});
```

This will log all pending, slow and completed requests, but will not detect errors. Error requests will be logged as
completed requests.

2. To log error requests separately, set the .error property explicitly in the express response:

```javascript
function errorResponse(request, response, message, debug) {
    if (response.rLog) {
        response.rLog.info.error = {message: message, debug: debug};
    }

    // Express stuff.
    config.getLogger().error('error', message, JSON.stringify(request.query), debug);
    response.header('Cache-Control', 'no-cache, private, no-store, must-revalidate, max-stale=0, post-check=0, pre-check=0');
    response.status(500).end(message);
}
```

3. To attach extra meta-information to the log record:

```javascript
if (res.rLog) {
	// Write additional meta info to log.
	if (req.user && req.user.id) {
		res.rLog.info.user = {id: req.user.id, name: req.user.username};
	}
	res.rLog.update();
}
```

3. To ignore some request:

```javascript
app.use(function(req, res, next) {
	if (res.rLog) {
		if (req.path == '/') {
			// Ignore nagios calls.
			res.rLog.ignore();
		}
	}
});
```

Notice that if the request has already been logged at the moment of calling .ignore, the key is not deleted from redis.
Preferably call ignore as soon as possible, for example in middleware appended directly after the request logger itself.
