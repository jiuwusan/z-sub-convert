'use strict';

const YAML = require('yaml');
const { AppError } = require('./auth');
const { transformConfig } = require('./transform');
const RULE_KEYS = ['proxies', 'proxy-groups', 'rules'];
const mapping = value => value && typeof value === 'object' && !Array.isArray(value);

function parseTemplate(content) {
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > 1024 * 1024) {
    throw new AppError('模板不能为空，且不能超过 1 MiB');
  }
  try { return YAML.parse(content); }
  catch { throw new AppError('模板 YAML 格式无效'); }
}

function validateRuleTemplate(content) {
  const document = parseTemplate(content);
  try {
    transformConfig(document, []);
    if (!Array.isArray(document.rules)) throw new TypeError('规则模板必须包含 rules 数组');
  } catch (error) { throw new AppError(`规则模板校验失败：${error.message}`); }
  return content;
}

function uniqueAddresses(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim() && !/[\r\n]/.test(value)).map(value => value.trim()))];
}

function splitTemplate(document) {
  if (!mapping(document)) throw new AppError('预置模板须为 YAML 对象');
  const base = structuredClone(document);
  const rules = Object.fromEntries(RULE_KEYS.map(key => [key, document[key] ?? []]));
  for (const key of RULE_KEYS) delete base[key];
  const nameservers = uniqueAddresses(base.dns?.nameserver);
  if (mapping(base.dns)) delete base.dns.nameserver;
  return { base, rules, nameservers };
}

function chooseNameservers(useSource, sourceAddresses, selectedAddresses) {
  const provided = useSource ? uniqueAddresses(sourceAddresses.flatMap(value => Array.isArray(value) ? value : [])) : [];
  const result = provided.length ? provided : uniqueAddresses(selectedAddresses);
  if (!result.length) throw new AppError('没有可用的 nameserver，请选择手动地址或为来源模式配置备用地址', 422);
  return result;
}

function composeTemplate(baseContent, ruleContent, nameservers) {
  const base = parseTemplate(baseContent);
  const rules = parseTemplate(validateRuleTemplate(ruleContent));
  if (!mapping(base)) throw new AppError('基础模板须为 YAML 对象才能生成订阅', 422);
  if (base.dns !== undefined && !mapping(base.dns)) throw new AppError('基础模板的 dns 须为 YAML 对象才能写入 nameserver', 422);
  const output = structuredClone(base);
  output.dns = { ...output.dns, nameserver: [...nameservers] };
  for (const key of RULE_KEYS) output[key] = structuredClone(rules[key]);
  return output;
}

module.exports = { parseTemplate, validateRuleTemplate, uniqueAddresses, splitTemplate, chooseNameservers, composeTemplate };
