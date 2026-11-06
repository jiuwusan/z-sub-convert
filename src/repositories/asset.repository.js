'use strict';

const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

class AssetRepository {
  constructor(directory) { this.directory = directory; }
  read(file) { return readFile(join(this.directory, file)); }
}

module.exports = { AssetRepository };
