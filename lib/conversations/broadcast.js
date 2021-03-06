
var _ = require('underscore');
var cowboy = require('../../index');
var events = require('events');
var util = require('util');

var conversationsBroadcastUtil = require('../internal/conversations.broadcast');

/**
 * Listen for a broadcast request by some broadcast channel `name`
 */
var listen = module.exports.listen = function(name) {
    var emitter = new events.EventEmitter();

    var broadcastChannelIn = cowboy.redis.createChannel(conversationsBroadcastUtil.getRequestChannelName(name));
    broadcastChannelIn.listen(function() {

        // We have received a broadcast request on the named channel
        broadcastChannelIn.on('data', function(message) {

            // Create the reply channel by extracting the broadcastId from the message
            var broadcastChannelOut = cowboy.redis.createChannel(conversationsBroadcastUtil.getReplyChannelName(name, message.broadcastId));
            broadcastChannelOut.send({'type': 'ack', 'host': _host()}, function(err) {
                if (err) {
                    return cowboy.logger.system().error({'err': err}, 'Failed to send broadcast request acknowledgement, ignoring request');
                }

                var closed = false;

                /*!
                 * Function that handles sending some reply data to the requester
                 */
                var _reply = function(replyData, callback) {
                    if (callback && !_.isFunction(callback)) {
                        throw new Error('Second parameter to reply function should either be unspecified or a function');
                    }
                    callback = callback || function() {};

                    // Don't send data after the response has been ended
                    if (closed) {
                        var err = new Error('Attempted to send response frame after response was ended');
                        cowboy.logger.system().error({'err': err, 'broadcastChannelName': name}, 'Rejecting attempt to send broadcast response frame after it was ended');
                        return callback(err);
                    }

                    broadcastChannelOut.send({'type': 'data', 'host': _host(), 'body': replyData}, callback);
                };

                /*!
                 * Function that handles indicating to the requester that we are finished our response
                 */
                var _end = function(callback) {
                    callback = callback || function() {};
                    closed = true;
                    var _err;

                    // First notify the requester that we've finished our response
                    broadcastChannelOut.send({'type': 'end', 'host': _host()}, function(err) {
                        if (err) {
                            _err = err;
                            cowboy.logger.system().warn({'err': err, 'broadcastChannelName': name}, 'Failed to send "end" message to broadcast response');
                        }

                        // Close the response channel
                        broadcastChannelOut.close(function(err) {
                            if (err) {
                                _err = err;
                                cowboy.logger.system().warn({'err': err, 'broadcastChannelName': name}, 'Failed to send close the broadcast output channel after "end" response');
                            }

                            return callback(_err);
                        });
                    });
                };

                // Now that we've acknowledged and are prepared to send response frames, emit the request event to the consumer
                return emitter.emit('request', message.body, _reply, _end);
            });
        });

        // Indicate that we've begun listening
        emitter.emit('listen');
    });

    emitter.close = function(callback) {
        broadcastChannelIn.close(callback);
    };

    return emitter;
};

/**
 * Send a broadcast request with the given `data` and channel `name`
 *
 * @param   {String}    name                            The `name` of the channel on which to send a broadcast request
 * @param   {Object}    data                            The arbitrary data to send as the request body
 * @param   {Object}    [options]                       Optional request options
 * @param   {Object}    [options.timeout]               The timeout behaviour of the request
 * @param   {Number}    [options.timeout.idle=5000]     The idle timeout of the request (in milliseconds)
 * @param   {Number}    [options.timeout.connect=5000]  The "connect" timeout of the request (i.e., the time before
 *                                                      first response) in milliseconds
*/
var request = module.exports.request = function(name, data, options) {
    options = options || {};
    options.expect = options.expect || cowboy.presence.hosts();
    options.timeout = options.timeout || {};
    options.timeout.connect = options.timeout.connect || 5000;
    options.timeout.idle = options.timeout.idle || 5000;

    var broadcastArgs = {
        'name': name,
        'data': data,
        'options': options
    };

    var hosts = _.invert(cowboy.presence.hosts());
    var closed = false;
    var responses = {};
    var expecting = _.chain(options.expect).invert().value();
    var start = Date.now();
    var lastMessage = 0;

    var emitter = new events.EventEmitter();

    // This is a weird case
    if (_.isEmpty(options.expect)) {
        process.nextTick(function() {
            return emitter.emit('end', responses);
        });

        return emitter;
    }

    // Generate a random broadcast id, which listeners will use to reply to us
    var broadcastId = cowboy.util.rnd();

    /*!
     * Tear down all of the resources and mark this channel as being closed
     */
    var _tearDown = function(callback) {
        // Ensure we don't tear down twice
        if (closed) {
            return;
        }
        closed = true;
        clearInterval(timeoutInterval);
        broadcastChannelIn.close(callback);
    };

    /*!
     * Indicates that we have timed out
     */
    var _timeout = function(reason) {
        _tearDown(function(err) {
            if (err) {
                cowboy.logger.system().warn({'err': err}, 'There was an error tearing down the broadcast conversation request after timeout');
            }

            if (_.isEmpty(responses)) {
                cowboy.logger.system().trace({'broadcastChannelName': name}, 'Connection timeout in broadcast channel');
                return emitter.emit('error', new Error(reason), _.keys(expecting));
            } else {
                cowboy.logger.system().trace({'broadcastChannelName': name}, 'Idle timeout in broadcast channel');
                return emitter.emit('end', responses, _.keys(expecting));
            }
        });
    };

    /*!
     * Indicates we have received acknowledgement from a host
     */
    var _receiveAck = function(host) {
        cowboy.logger.system().trace({'host': host}, 'Received broadcast acknowledgement from a host');

        expecting[host] = true;
        if (!responses[host]) {
            responses[host] = [];
        }

        return emitter.emit('ack', host);
    };

    var _receiveData = function(host, body) {
        cowboy.logger.system().trace({'host': host, 'body': body}, 'Received broadcast data from a host');

        // Record the data and indicate that we are still expecting something from this host, either more "data" or an "end"
        responses[host] = responses[host] || [];
        responses[host].push(body);
        expecting[host] = true;

        return emitter.emit('data', host, body);
    };

    /*!
     * Indicates that we received an "end" request from a host
     */
    var _receiveEnd = function(host) {
        cowboy.logger.system().trace({'host': host}, 'Received broadcast end from a host');

        // Indicate we are no longer waiting for anything from this host now that it finished
        delete expecting[host];

        // Indicate that one host has ended
        emitter.emit('hostEnd', host, responses[host]);

        // If we aren't waiting on responses from any other hosts we can finish up
        if (_.isEmpty(expecting)) {
            _tearDown(function(err) {
                if (err) {
                    cowboy.logger.system().warn({'err': err}, 'There was an error tearing down the broadcast conversation request after successful completion');
                }

                return emitter.emit('end', responses);
            });
        }
    };

    // Handle connect and idle timeouts
    var timeoutInterval = setInterval(function() {
        if (closed) {
            return;
        }

        if (!lastMessage) {
            // If we have not received a message yet, we check if we have exceeded the "connect" timeout
            if (Date.now() > (start + options.timeout.connect)) {
                return _timeout(util.format('Did not receive a message within the connect timeout interval of %sms', options.timeout.connect));
            }
        } else if (Date.now() > (lastMessage + options.timeout.idle)) {
            // We have received a message, so check if we have exceeded an idle timeout
            return _timeout(util.format('Did not receive a message with the idle timeout interval of %sms', options.timeout.idle));
        }
    }, 10);

    // Start listening for responses on the unique broadcast reply channel
    var broadcastChannelIn = cowboy.redis.createChannel(conversationsBroadcastUtil.getReplyChannelName(name, broadcastId));
    broadcastChannelIn.listen(function(err) {
        if (closed) {
            return;
        } else if (err) {
            cowboy.logger.system().error({'err': err, 'broadcast': broadcastArgs}, 'Failed to begin listening for broadcast replies');
            _tearDown(function() {
                return emitter.emit('error', err);
            });
        }

        // Handle all replies to this broadcast stream
        broadcastChannelIn.on('data', function(message) {
            if (closed) {
                // The broadcast session is already closed, so don't process more messages
                return;
            }

            // Record that we received a message now
            lastMessage = Date.now();

            // Handle the message depending on its type
            if (message.type === 'ack') {
                _receiveAck(message.host);
            } else if (message.type === 'data') {
                _receiveData(message.host, message.body);
            } else if (message.type === 'end') {
                return _receiveEnd(message.host);
            }
        });

        // Send the message and emit an error if there was an error sending
        var broadcastChannelName = conversationsBroadcastUtil.getRequestChannelName(name);
        var message = {
            'broadcastId': broadcastId,
            'host': _host(),
            'body': data
        };

        // Now that we're ready to accept responses, send the request
        cowboy.redis.createChannel(broadcastChannelName).send(message, function(err) {
            if (err) {
                cowboy.logger.system().error({'err': err}, 'Failed to send a broadcast message broadcast message');
                _tearDown(function() {
                    return emitter.emit('error', err);
                });
                return;
            }

            cowboy.logger.system().trace({
                'broadcastChannelName': broadcastChannelName,
                'message': message,
                'expecting': _.keys(expecting)
            }, 'Sent request broadcast request');
        });
    });

    emitter.broadcastId = function() {
        return broadcastId;
    };

    return emitter;
};

/*!
 * Convenience function to get the hostname of the current node
 */
var _host = function() {
    return cowboy.data.get('hostname');
};
