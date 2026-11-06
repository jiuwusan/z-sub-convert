'use strict';

class AppError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
  }
}

class SubscriptionError extends Error {
  constructor(message, statusCode, options) {
    super(message, options);
    this.name = 'SubscriptionError';
    this.statusCode = statusCode;
  }
}

class TemplateError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'TemplateError';
    this.statusCode = 500;
  }
}

module.exports = { AppError, SubscriptionError, TemplateError };
