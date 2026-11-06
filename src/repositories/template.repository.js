'use strict';

const { readFile } = require('node:fs/promises');
const YAML = require('yaml');
const { TemplateError } = require('../utils/errors');

async function loadTemplate(templatePath) {
  let source;
  try {
    source = await readFile(templatePath, 'utf8');
  } catch (error) {
    throw new TemplateError('Unable to load the configured template', { cause: error });
  }
  try {
    return YAML.parse(source);
  } catch (error) {
    throw new TemplateError('The configured template is not valid YAML', { cause: error });
  }
}

module.exports = { loadTemplate };
