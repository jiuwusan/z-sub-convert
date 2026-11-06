'use strict';
const { AppError, SubscriptionError, TemplateError } = require('../utils/errors');
const { sendJson } = require('../utils/http-response');
function publicErrorDetails(error) {
  const statusCode = error instanceof SubscriptionError || error instanceof TemplateError || error instanceof AppError ? error.statusCode : 500;
  return { statusCode, message: statusCode === 500 && !(error instanceof TemplateError) ? 'Internal server error' : error.message };
}
function publicError(error, response, headOnly, logger, details = publicErrorDetails(error)) {
  logger.error(`${error.name || 'Error'}: ${details.message}`);
  sendJson(response, details.statusCode, { error: details.message }, headOnly);
}
function adminError(error, response, headOnly, logger) {
  const status = error instanceof AppError || error instanceof SubscriptionError ? error.statusCode : 500;
  sendJson(response, status, { error: status === 500 ? '服务暂不可用，请检查服务器日志' : error.message }, headOnly);
  if (status === 500) logger.error('Admin request failed');
}
module.exports = { publicErrorDetails, publicError, adminError };
