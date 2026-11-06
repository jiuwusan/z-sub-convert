'use strict';

const YAML = require('yaml');
const { splitSubscriptionUrls, fetchSubscriptionDocument } = require('../gateways/subscription.gateway');
const { transformConfig } = require('../domain/transform');
const { loadTemplate } = require('../repositories/template.repository');
const { TemplateError } = require('../utils/errors');

class ConversionService {
  constructor(options) { this.options = options; }

  async convert(rawUrl) {
    const urls = splitSubscriptionUrls(rawUrl);
    const sources = await Promise.all(urls.map(url => fetchSubscriptionDocument(url, this.options)));
    const template = await loadTemplate(this.options.templatePath);
    let output;
    try {
      output = transformConfig(template, sources.map(source => source.proxies), {
        sourceHosts: sources.map(source => source.hosts), sourceDns: sources.map(source => source.dns)
      });
    } catch (error) {
      throw new TemplateError('The configured template or upstream proxies have an invalid structure', { cause: error });
    }
    return YAML.stringify(output, { lineWidth: 0 });
  }
}

module.exports = { ConversionService };
