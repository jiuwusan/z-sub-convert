'use strict';
class RecordService {
  constructor(repository) { this.repository = repository; }
  list(id, page) { return this.repository.list(id, page); }
  append(id, record) { return this.repository.append(id, record); }
}
module.exports = { RecordService };
