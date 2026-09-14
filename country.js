'use strict';

const PRIORITY_NAMES = ['新加坡', '日本', '美国', '香港', '台湾', '韩国'];

const COUNTRY_DATA = [
  ['SG', '🇸🇬', '新加坡', ['Singapore', '狮城']],
  ['JP', '🇯🇵', '日本', ['Japan', 'Tokyo']],
  ['US', '🇺🇸', '美国', ['United States', 'United States of America', 'America', 'USA']],
  ['HK', '🇭🇰', '香港', ['Hong Kong', 'HongKong']],
  ['TW', '🇹🇼', '台湾', ['台灣', 'Taiwan', 'Taipei']],
  ['KR', '🇰🇷', '韩国', ['韓國', 'South Korea', 'Korea', 'Seoul']],
  ['CN', '🇨🇳', '中国', ['中國', 'China', 'Mainland']],
  ['GB', '🇬🇧', '英国', ['英國', 'United Kingdom', 'Great Britain', 'Britain', 'England', 'UK']],
  ['DE', '🇩🇪', '德国', ['德國', 'Germany']],
  ['FR', '🇫🇷', '法国', ['法國', 'France']],
  ['CA', '🇨🇦', '加拿大', ['Canada']],
  ['AU', '🇦🇺', '澳大利亚', ['澳大利亞', 'Australia']],
  ['RU', '🇷🇺', '俄罗斯', ['俄羅斯', 'Russia']],
  ['IN', '🇮🇳', '印度', ['India']],
  ['NL', '🇳🇱', '荷兰', ['荷蘭', 'Netherlands', 'Holland']],
  ['CH', '🇨🇭', '瑞士', ['Switzerland']],
  ['SE', '🇸🇪', '瑞典', ['Sweden']],
  ['NO', '🇳🇴', '挪威', ['Norway']],
  ['FI', '🇫🇮', '芬兰', ['芬蘭', 'Finland']],
  ['DK', '🇩🇰', '丹麦', ['丹麥', 'Denmark']],
  ['IT', '🇮🇹', '意大利', ['Italy']],
  ['ES', '🇪🇸', '西班牙', ['Spain']],
  ['PT', '🇵🇹', '葡萄牙', ['Portugal']],
  ['PL', '🇵🇱', '波兰', ['波蘭', 'Poland']],
  ['IE', '🇮🇪', '爱尔兰', ['愛爾蘭', 'Ireland']],
  ['AT', '🇦🇹', '奥地利', ['奧地利', 'Austria']],
  ['BE', '🇧🇪', '比利时', ['比利時', 'Belgium']],
  ['CZ', '🇨🇿', '捷克', ['Czechia', 'Czech Republic']],
  ['RO', '🇷🇴', '罗马尼亚', ['羅馬尼亞', 'Romania']],
  ['TR', '🇹🇷', '土耳其', ['Turkey', 'Türkiye']],
  ['IL', '🇮🇱', '以色列', ['Israel']],
  ['AE', '🇦🇪', '阿联酋', ['阿聯酋', 'United Arab Emirates', 'UAE']],
  ['SA', '🇸🇦', '沙特阿拉伯', ['Saudi Arabia']],
  ['TH', '🇹🇭', '泰国', ['泰國', 'Thailand']],
  ['VN', '🇻🇳', '越南', ['Vietnam']],
  ['MY', '🇲🇾', '马来西亚', ['馬來西亞', 'Malaysia']],
  ['ID', '🇮🇩', '印度尼西亚', ['印度尼西亞', 'Indonesia']],
  ['PH', '🇵🇭', '菲律宾', ['菲律賓', 'Philippines']],
  ['BR', '🇧🇷', '巴西', ['Brazil']],
  ['AR', '🇦🇷', '阿根廷', ['Argentina']],
  ['CL', '🇨🇱', '智利', ['Chile']],
  ['MX', '🇲🇽', '墨西哥', ['Mexico']],
  ['ZA', '🇿🇦', '南非', ['South Africa']],
  ['NZ', '🇳🇿', '新西兰', ['新西蘭', 'New Zealand']]
];

const COUNTRIES = COUNTRY_DATA.map(([code, flag, name, aliases]) => ({
  code,
  flag,
  name,
  aliases: [name, ...aliases],
  priority: PRIORITY_NAMES.indexOf(name) === -1
    ? PRIORITY_NAMES.length
    : PRIORITY_NAMES.indexOf(name)
}));

const OTHER = Object.freeze({
  code: 'OTHER',
  flag: '🏳️',
  name: '其他',
  priority: Number.MAX_SAFE_INTEGER
});

function publicCountry(country) {
  return {
    code: country.code,
    flag: country.flag,
    name: country.name,
    priority: country.priority
  };
}

function detectCountry(value) {
  const text = typeof value === 'string' ? value : '';

  for (const country of COUNTRIES) {
    if (text.includes(country.flag)) return publicCountry(country);
  }

  const folded = text.toLocaleLowerCase('en-US');
  for (const country of COUNTRIES) {
    if (country.aliases.some((alias) => {
      if (/^[A-Z]{2,3}$/.test(alias)) {
        return new RegExp(`(^|[^A-Za-z])${alias}(?=$|[^A-Za-z])`, 'i').test(text);
      }
      return folded.includes(alias.toLocaleLowerCase('en-US'));
    })) {
      return publicCountry(country);
    }
  }

  for (const country of COUNTRIES) {
    const pattern = new RegExp(`(^|[^A-Za-z])${country.code}(?=$|[^A-Za-z])`, 'i');
    if (pattern.test(text)) return publicCountry(country);
  }

  return { ...OTHER };
}

function compareCountries(left, right) {
  if (left.priority !== right.priority) return left.priority - right.priority;
  if (left.code === 'OTHER') return right.code === 'OTHER' ? 0 : 1;
  if (right.code === 'OTHER') return -1;
  return left.name.localeCompare(right.name, 'zh-CN');
}

module.exports = {
  COUNTRIES,
  detectCountry,
  compareCountries
};
