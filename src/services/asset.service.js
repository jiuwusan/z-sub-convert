'use strict';

class AssetService {
  constructor(repository) { this.repository = repository; }
  read(file) { return this.repository.read(file); }
}

module.exports = { AssetService };
