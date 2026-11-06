'use strict';

function send(response, statusCode, headers, body, headOnly) {
  response.writeHead(statusCode, headers);
  response.end(headOnly ? undefined : body);
}

function sendJson(response, statusCode, payload, headOnly = false, extraHeaders = {}) {
  send(response, statusCode, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders }, JSON.stringify(payload), headOnly);
}

module.exports = { send, sendJson };
