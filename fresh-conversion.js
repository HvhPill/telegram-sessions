'use strict';
const path = require('node:path');
const { Engine, readJSON, errorCode } = require('./engine');

// Reuse the rotation transaction: both formats must be verified before source logout.
class FreshConversion {
  constructor(config, emit, prompt, overrides = {}) {
    this.config = config; this.emit = emit; this.prompt = prompt; this.overrides = overrides;
    this.current = null; this.stopped = false;
  }
  get stop() { return this.stopped; }
  set stop(value) { this.stopped = value; if (this.current) this.current.stop = value; }
  async run(_direction, inputs) {
    const results = [];
    for (const input of inputs) {
      if (this.stop) break;
      const name = path.basename(input);
      const emit = event => {
        if (event.type === 'stage') this.emit({type:'conversion', name, detail:event.detail, status:'running'});
        if (['prompt','warning'].includes(event.type)) this.emit(event);
      };
      try {
        const engine = new Engine({...this.config, input:path.dirname(input), forceNew:true, keepOld:false}, emit, this.prompt, this.overrides);
        this.current = engine;
        const [result] = await engine.run([name]);
        if (!result) { this.stop = true; break; }
        if (result.status !== 'complete') {
          results.push(result); this.emit({type:'conversion',name,detail:result.error || result.status,status:result.status});
          if (result.status === 'cancelled') this.stop = true;
          continue;
        }
        const journal = readJSON(path.join(this.config.output,'.state',path.basename(input,'.session')+'.json'));
        const files = [journal.session_file, journal.tdata_path];
        const detail = 'Новая сессия и tdata созданы и проверены' + (result.warning ? ' · Предупреждение: ' + result.warning : '');
        results.push({...result, name, files, detail});
        this.emit({type:'conversion',name,status:'complete',detail});
      } catch (error) {
        const code = errorCode(error); results.push({name,status:'failed',error:code});
        this.emit({type:'conversion',name,status:'failed',detail:code});
      } finally { this.current = null; }
    }
    return results;
  }
}
module.exports = { FreshConversion };
