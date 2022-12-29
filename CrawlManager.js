/* global DwebTransports */
/* es-lint-disable no-use-before-define */
const prettierBytes = require('prettier-bytes');
const queue = require('async/queue');
const waterfall = require('async/waterfall');
const each = require('async/each');
const asyncUntil = require('async/until');
// const eachSeries = require('async/eachSeries');
const debug = require('debug')('dweb-mirror:CrawlManager');
const { ObjectFilter, ObjectFromEntries } = require('@internetarchive/dweb-archivecontroller');
// Need these patches even if const unused
const ArchiveItem = require('./ArchiveItemPatched');
const ArchiveFile = require('./ArchiveFilePatched');
require('./ArchiveMemberPatched');
const MirrorFS = require('./MirrorFS');

/*
  Manage crawls

  crawlOpts {
    identifier: "foo",
    level: "tile" || "metadata" || "details",   // tile is sufficient to display in a search/collection, metadata is that + info; details is sufficient to display in details page (incs related); all
    search: [ { sort, rows, level } ]

  opts {
    noCache: bool||false      If true will ignore the cache, this is useful to make sure hits server to ensure it precaches/pushes to IPFS etc
    skipFetchFile: bool||false  If true will just comment on file, not actually fetch it (including thumbnails)
    maxFileSize: 10000000       If set, constrains maximum size of any one file
    crawlPalmLeaf: bool||false  If set will fetch specific pages wiki uses i.e. closest quantized size to 400px,2000px and full size

  Example initialization:
  search([
  { identifier: "foo", level: "metadata" }
  { identifier: "prelinger", level: "details", search: [                     // Fetch details for prelinger
        { sort: "-downloads", rows: 100, level: "details" }        // Query first 100 items and get their details
        { sort: "-downloads", rows: 200, level: "tile" } ] }  // and next 200 items and get their thumbnails only
  ]

TODO - some duplication between this and above.
The crawl is initialized from a data-structure, or indirectly from YAML. Syntax of object is
[ {
    identifier:     Archive identifier OR array of them OR `` for Home
    level:          any of "tile" "metadata" "details" "all"
    query:          Alternative to identifier, specify a query
    search: {       How to search on this item (if its a query or mediatype=collection)
        sort:       Sort order e.g. "-downloaded" or "titleSorter"
        rows:       Integer - number of rows to read
        level:      At what level ("tile" is sufficent to paint the query results)
        search:     This recurses, and applies a search to do on each search result
        related: {  How many, and at how much detail to explore related items.
            rows, level, search, related }  As for the search field.

Configuration file example
apps:
  crawl:
    tasks:
      # Get 40 search results for Prelinger, first 10 at details (sufficient to display), then 30 at tile
      # and get the tiles for the 6 most related items
      - identifier: "prelinger"
        level: "details"
        search:
          - sort: "-downloads"
            rows: 10
            level: "tile"

          - sort: "-downloads"
            rows: 30
            level: "tile"
        related:
          - rows: 6
            level: "tile"
 */
/**
 * Common parameters:
 * crawlmanager: instance of CrawlManager TODO camelCase it
 */


// TODO may want to add way to specify certain media types only (in search{}?) but do not currently have an application for that.

class CrawlManager {
  // Manages crawls, each crawl (a group of tasks going to one device) is a CrawlManager instance.
  /**
   _levels: ["tile", "metadata", "details", "all"]  Allowable task levels, in order.
   crawls: [CRAWLMANAGER]  Array of CrawlManagers for each crawl run so far since startup (TODO will start culling),
   ```
   Each instance of CrawlManager has the following attributes:
   ```
   _taskQ          (async queue) of tasks to run (from async package)
   _uniqItems      { identifier: [ task* ] } Dictionary of tasks carried out per item, used for checking uniqueness and avoiding loops
   (identifier also has pseudo-identifiers like _SEARCH_123abc
   _uniqFiles      { identifier: [ task* ] } Dictionary of tasks carried out per file
   callbackDrainOnce (bool) True if should only call drain callback first time queue empties out.
   completed       Count of tasks completed (for reporting)
   concurrency     (int) Sets the number of tasks that can be processed at a time
   copyDirectory   If set, the crawl will make a full copy here, for example on a USB drive
   debugidentifier Will be set to a global variable to help conditional debugging
   defaultDetailsSearch    Default search to perform as part of "details" or "full" (usually sufficient to paint tiles)
   defaultDetailsRelated   Default crawl on related items when doing "details" or "full" (usually sufficient to paint tiles)
   errors          [{task, error}] Array of errors encountered to report on at the end.
   initialItemTaskList: [TASK] Tasks to run each time crawl runs
   limitTotalTasks (int) If set, limits the total number of tasks that can be handled in a crawl, this is approx the number of items plus number of files
   maxFileSize     (int) If set, constrains maximum size of any one file
   name            (string) Name of the crawl - for display purposes
   noCache         If true will ignore the cache, this is useful to make sure hits server to ensure it precaches/pushes to IPFS etc
   pushedCount     Count of tasks pushed onto the queue, used for checking against limitTotalTasks
   skipFetchFile   If true will just comment on file, not actually fetch it (including thumbnails)

   */

  constructor({
    initialItemTaskList = [], copyDirectory = undefined, debugidentifier = undefined, skipFetchFile = false,
    noCache = false, maxFileSize = undefined, concurrency = 1, limitTotalTasks = undefined,
    crawlEpubs = undefined, crawlPalmLeaf = false,
    defaultDetailsSearch = undefined, defaultDetailsRelated = undefined, callbackDrainOnce = false, name = undefined
  } = {}) {
    this.clearState();
    this.setopts({
      initialItemTaskList,
      copyDirectory,
      debugidentifier,
      skipFetchFile,
      noCache,
      maxFileSize,
      concurrency,
      limitTotalTasks,
      crawlEpubs,
      crawlPalmLeaf,
      defaultDetailsSearch,
      defaultDetailsRelated,
      callbackDrainOnce,
      name
    });
    this._taskQ = queue((task, cb) => {
      // Tasks will loop from 1-5 secs if disconnected, the randomness is to spread tasks out.
      asyncUntil(
        // TODO maybe push this to dweb-transports as waitConnected:true argument to statuses
        cb3 => cb3(DwebTransports.statuses({ connected: true }).length && (this.copyDirectory || MirrorFS.directories.length)),
        cb2 => setTimeout(cb2, Math.floor(1000 + 4000 * Math.random())),
        (unusedErr) => {
          task.process(this, (err) => {
            this.completed++;
            if (err) this.errors.push({ task, error: err, date: (new Date(Date.now()).toISOString()) });
            // cb(err); // I'm seeign the crawler freeze and seems to be after an error so trying without passing error back up.
            cb();
          }); // Task should be an instance of a class with a process method
        }
      );
    }, this.concurrency);
    let bounddrained = this.drained.bind(this);
    this._taskQ.drain(bounddrained); // async3

    if (typeof CrawlManager.crawls === 'undefined') CrawlManager.crawls = [];
    CrawlManager.crawls.push(this); // Make crawl findable
  }

  clearState() {
    // Clear out any state before running/re-running.
    this._uniqItems = {};
    this._uniqFiles = {}; // This is actually needed since an Item might be crawled a second time at a deeper level
    this.errors = [];
    this.completed = 0;
    this.pushedCount = 0;
  }

  _push(task) {
    /*
        task:   { CrawlItem | CrawlFile } or [ task ]
        Push a task onto the queue
        Add a task to _taskQ provided performing some checks first (esp limitTotalTasks)
     */
    if (!this.limitTotalTasks || (this.pushedCount <= this.limitTotalTasks)) {
      this._taskQ.push(task);
    } else {
      debug('ERROR raise limitTotalTasks');
      this.errors.push({ task, error: new Error(`Skipping ${task.debugname} as reached maximum of ${this.limitTotalTasks} tasks`), date: (new Date(Date.now()).toISOString()) });
    }
  }

  pushTask(task) {
    /*
        task:   { identifier, ... } args to CrawlItem  or [task*]
        Create a new subclass of Crawlable and _push it
        If identifier is an array, then expand into multiple tasks.
        If task is an array, iterate over it
     */
    if (Array.isArray(task)) {
      task.forEach(t => this.pushTask(t));
    } else if (Array.isArray(task.identifier)) {
      task.identifier.forEach(identifier => this.pushTask(Object.assign({}, task, { identifier })));
    } else if (task.identifier && task.identifier.includes('/') && task.identifier !== '/') { // want a file rather than an identifier
      this._push(new CrawlFile({ relfilepath: task.identifier }, []));
    } else { // Could be item (specified by identifier) or a search (specified by a query)
      this._push(new CrawlItem(Object.assign({}, task, { crawlmanager: this }), []));
    }
  }

  /**
   * Set any of the attributes, doing sme minimal preprocesssing first
   */
  setopts(opts = {}) {
    Object.entries(opts).forEach(kv => this[kv[0]] = kv[1]);
    // if (opts.copyDirectory) { } // If Crawling to a directory - no action reqd any more since MirrorFS now creates hashstore lazily
    if (opts.concurrency && this._taskQ) this._taskQ.concurrency = opts.concurrency; // _tasQ already started, but can modify it
  }

  static startCrawl(initialItemTaskList, {
    copyDirectory = undefined, debugidentifier = undefined, skipFetchFile = false, noCache = false,
    maxFileSize = undefined, concurrency = 1, limitTotalTasks = undefined, defaultDetailsSearch = undefined,
    callbackDrainOnce = undefined, defaultDetailsRelated = undefined, name = undefined, crawlEpubs = false, crawlPalmLeaf = false
  } = {}, cb) {
    const CM = new CrawlManager({
      initialItemTaskList,
      copyDirectory,
      debugidentifier,
      skipFetchFile,
      noCache,
      maxFileSize,
      concurrency,
      limitTotalTasks,
      defaultDetailsRelated,
      defaultDetailsSearch,
      callbackDrainOnce,
      name,
      crawlEpubs,
      crawlPalmLeaf
    });
    debug('Starting crawl %d tasks opts=%o', initialItemTaskList.length,
      ObjectFilter(CM, (k, v) => v && this.optsallowed.includes(k)));
    if (copyDirectory) {
      debug('Will use %s for the crawl and %o as a cache', copyDirectory, MirrorFS.directories);
    } else if (!MirrorFS.directories.length) {
      debug('WARNING: No cache directories available, crawl will wait');
    } else {
      debug('Will use %o as the cache for the crawl (storing in the first, unless item exists in another', MirrorFS.directories);
    }
    CM.restart();
    CM.drainedCb = cb; // Whether its called on each drain, or just once depends on callbackDrainOnce
  }

  /**
   * Called when final task processed, to report on results and if set call the drainedCb
   */
  drained() {
    debug('Crawl finished %d tasks with %d errors', this.completed, this.errors.length);
    this.errors.forEach(e => debug('ERR:%o %s %o %o %s',
      e.task.parent.concat(e.task.debugname), e.task.level, e.task.search || '', e.task.related || '', e.error.message));
    const drainedCb = this.drainedCb;
    if (this.callbackDrainOnce) { this.drainedCb = undefined; this.callbackDrainOnce = undefined; } // Dont call it if restarted
    if (drainedCb) drainedCb();
  }

  // CONTROL FUNCTIONS UNDER DEV
  /**
   * Start crawl from beginning
   */
  restart() { // UI [<<]
    this.empty(); // Note there may be some un-stoppable file retrievals happening
    this.clearState();
    this.pushTask(this.initialItemTaskList); // Push original tasks onto list
  }

  /**
   * Pause crawl (note restart wont start it going again)
   */
  pause() { // UI  [||]
    this._taskQ.pause();
  }

  /**
   * Unpause a crawl
   */
  resume() { // UI [>]
    this._taskQ.resume();
  }

  /**
   * Clear out a taskQ on a crawl
   * @param identifier
   */
  empty({ identifier = undefined } = {}) { // UI [X]
    this._taskQ.remove(task => (
      identifier
        ? (identifier === task.identifier)
        : true)); // Passed {data, priority} but removing all anyway
  }

  /**
   * Report the status of a crawl as some JSON:
   * @returns {{opts: *, initialItemTaskList: *, name: *, queue: {running: *, paused: *, workersList: *, length: *, completed: number, pushed: *, concurrency: *}, errors: {date: *, task: (CrawlItem|CrawlItem), error: {name: *, message: *}}[]}}
   */
  status() {
    return {
      name: this.name,
      queue: {
        length: this._taskQ.length(), // How many waiting to run
        running: this._taskQ.running(), // How many being run by tasks
        workersList: this._taskQ.workersList().map(worker => worker.data), // Its a task e.g. CrawlItem or CrawlFile
        concurrency: this._taskQ.concurrency,
        completed: this.completed, // May want to split into files and items
        pushed: this.pushed, // Should be length + running + completed
        paused: this._taskQ.paused,
      },
      opts: ObjectFromEntries(CrawlManager.optsallowed.map(k => [k, this[k]])),
      initialItemTaskList: this.initialItemTaskList,
      errors: this.errors.map(err => ({ date: err.date, task: err.task, error: { name: err.error.name, message: err.error.message } })), // [ { task, error } ]
    };
  }

  static status() {
    return this.crawls.map(crawl => crawl.status());
  }

  /**
   * Handle a status change, by removing any queued tasks, debouncing (waiting in case user clicks again) and then running whatever final task chosen
   * Note that config should be a live pointer, that can be accessed when the task is queued.
   * @param identifier
   * @param delayTillReconsider
   * @param config
   */
  suspendAndReconsider({ identifier = undefined, delayTillReconsider = 0, config = undefined } = {}) {
    // Handle a status change, by removing any queued tasks, debouncing (waiting in case user clicks again) and then running whatever final task chosen
    this.empty({ identifier }); // remove identifier from queue
    setTimeout(() => {
      // reload initialItemTaskList from config after the timeout, during which it might have changed
      this.setopts({ initialItemTaskList: config.apps.crawl.tasks });
      this.pushTask( // Start a task for ...
        this.initialItemTaskList.filter(t => t.identifier === identifier)
      ); // Any tasks that match identifier - maybe none or multiple but usually one
    }, delayTillReconsider);
  }

  static findOrCreateCrawlManager({ config, copyDirectory }) {
    // Find a crawlmanager to use for a copyDirectory - creating if reqd
    return this.crawls.find(cm => cm.copyDirectory === copyDirectory)
      || new CrawlManager(Object.assign({}, config.apps.crawl.opts, { copyDirectory, debugidentifier: copyDirectory, name: copyDirectory }));
  }

  /**
   * Called to do a one-time crawl of an item
   * @param identifier
   * @param query
   * @param config
   * @param copyDirectory
   * @param cb
   */
  // Test is curl -Lv http://localhost:4244/admin/crawl/add/AboutBan1935?copyDirectory=/Volumes/Transcend/archiveorgtest20190701
  static add({
    identifier = undefined,
    query = undefined,
    config = undefined,
    rows = undefined,
    level = 'details',
    copyDirectory = undefined
  }, cb) {
    // Called by mirrorHttp to do a one-time crawl of an item
    const crawlmanager = copyDirectory
      ? this.findOrCreateCrawlManager({ config, copyDirectory })
      : this.crawls[0];
    // Note this wont restart a paused crawl, if crawl has finished then pushing a task will make it continue
    if (identifier === 'local') {
      crawlmanager.pushTask(config.apps.crawl.tasks); // Push the default tasks, these might or might not be the crawlmanger.initialTaskList
    } else {
      const task = { identifier, query, level, crawlmanager };
      if (rows) { task.search = {rows, level}};
      crawlmanager._push(new CrawlItem(task, []));
    }
    cb(null); // No errors currently
  }
}
//  *** NOTE THIS _levels LINE IS IN dweb-mirror.CrawlManager && dweb-archive/components/ConfigDetailsComponent.js && assumptions about it in dweb-archive/dweb-archive-styles.css
CrawlManager._levels = ['tile', 'metadata', 'details', 'all'];
CrawlManager.crawls = [];
CrawlManager.optsallowed = ['debugidentifier', 'skipFetchFile', 'noCache', 'maxFileSize', 'concurrency', 'limitTotalTasks', 'copyDirectory', 'defaultDetailsSearch', 'defaultDetailsRelated'];
// q.drain = function() { console.log('all items have been processed'); }; // assign a callback *
// q.push({name: 'foo'}, function(err) { console.log('finished processing foo'); }); // add some items to the queue
// q.push([{name: 'baz'},{name: 'bay'},{name: 'bax'}], function(err) { console.log('finished processing item'); }); // add some items to the queue (batch-wise)
// q.unshift({name: 'bar'}, function (err) { console.log('finished processing bar'); });// add some items to the front of the queue

/**
 * Synonymous with task, its the parent class for other tasks
 */
class Crawlable {
  constructor(debugname, parent) {
    /* Common between CrawlFile and CrawlItem - only ever called as `super()`
        debugname   str name of this object (for debugging)
        parent      [str*] names of parents (for debugging) (oldest first)
     */
    this.debugname = debugname; // Used to display messages
    this.parent = parent; // Used to display path thru crawl to this task
  }

  asParent() {
    // Return new parent array (this crawlable's parent array + debugname)
    return this.parent.concat(this.debugname);
  }
}

class CrawlFile extends Crawlable {
  constructor(opts, parent) {
    /*
        requires: parent + (file|relfilepath|filename+(archiveitem|identifier))
        file    ArchiveFile
        relfilepath     IDENTIFIER/FILENAME
        filename    Path (within item, i.e. may contain /)
        identifier  Identifier of item
        archiveitem ArchiveItem
        parent  [str*] see Crawlable
     */
    // noinspection JSUnusedLocalSymbols
    const {
      file = undefined, relfilepath = undefined, identifier = undefined, filename = undefined
    } = opts;
    const name = relfilepath || (identifier ? [identifier, filename].join('/') : file.metadata.name);
    super(name, parent);
    Object.assign(this, opts); // Handle opts in process as may be async
  }

  /**
   * Process a ArchiveFile, retrieve it if not already cached, depends on state of skipFetchFile & maxFileSize
   * cb(err) Called when item processed - errors should be reported when encountered and then at the end of the crawl.
   * @param cb
   */
  process(crawlmanager, cb) {
    const copyDirectory = crawlmanager.copyDirectory;
    if (!this.file) {
      if (this.relfilepath) {
        const pp = this.relfilepath.split('/');
        this.identifier = pp.shift();
        this.filename = pp.join('/'); // May contain /'s
      }
      // Should have identifier and filename by here
      if (!this.archiveitem) {
        this.archiveitem = new ArchiveItem({ identifier: this.identifier });
      }
      ArchiveFile.new({ archiveitem: this.archiveitem, filename: this.filename, copyDirectory }, (err, res) => {
        this.file = res;
        this.process(crawlmanager, cb); // Recurse
      });
    } else if (this.isUniq(crawlmanager)) {
      if (!(crawlmanager.maxFileSize && (parseInt(this.file.metadata.size, 10) > crawlmanager.maxFileSize))) {
        debug('Processing "%s" File via %o', this.file.metadata.name, this.parent); // Parent includes identifier
        const skipFetchFile = crawlmanager.skipFetchFile;
        this.file.cacheAndOrStream({
          skipFetchFile,
          copyDirectory,
          wantStream: false,
          start: 0,
          end: undefined,
        }, cb);
      } else {
        const msg = `Skipping ${this.file.metadata.name} via ${this.parent.join('/')} size ${prettierBytes(parseInt(this.file.metadata.size, 10))} > ${prettierBytes(crawlmanager.maxFileSize)}`;
        debug(msg);
        cb(new Error(msg));
      }
    } else {
      cb();
    }
  }

  /**
   * returns true iff have not already tried this file on this crawl.
   */
  isUniq(crawlmanager) {
    const key = [this.file.identifier, this.file.metadata.name].join('/');
    const prevTasks = crawlmanager._uniqFiles[key];
    if (prevTasks) { return false; } else {
      crawlmanager._uniqFiles[key] = this;
      return true;
    }
  }
}

class CrawlPage extends Crawlable {
    /**
        requires: parent + archiveitem + identifier + (page || scale+rotate+zip+file)
        identifier  Identifier of item
        archiveitem ArchiveItem
        pageParms { As passed to fetch_page
          page    string - usually "cover_t.jp2"
          scale   int usually 2 (larger = smaller image)
          rotate  int usually 0
          zip     name of directory
          file    file inside zip
        }
        debugname str see Crawlable
        parent    [str*] see Crawlable
     */
  constructor(opts, parent) {
    const {
      identifier = undefined, pageParms
    } = opts;
    const name = (pageParms.page ? [identifier, pageParms.page] : [identifier + pageParms.zip, pageParms.file]).join('/');
    super(name, parent);
    Object.assign(this, opts); // Handle opts in process as may be async
  }

  /**
   * Process a Page of an ArchiveItem, retrieve it if not already cached, depends on state of skipFetchFile & maxFileSize
   * @param crawlmanager
   * @param cb(err) Called when item processed - errors should be reported when encountered and then at the end of the crawl.
   */
  process(crawlmanager, cb) {
    console.assert(this.archiveitem, 'Crawl of page needs archiveitem');
    if (this.isUniq(crawlmanager)) {
      // if (!(crawlmanager.maxFileSize && (parseInt(this.file.metadata.size) > crawlmanager.maxFileSize))) {
      debug('Processing "%s" %s x1/%s rotate=%s via %o', this.identifier,
        this.pageParms.page || (this.pageParms.zip + '/' + this.pageParms.file), this.pageParms.scale, this.pageParms.rotate, this.parent); // Parent includes identifier
      this.archiveitem.fetch_page(Object.assign(this.pageParms, {
        copyDirectory: crawlmanager.copyDirectory,
        wantStream: false,
        noCache: false,
        skipFetchFile: crawlmanager.skipFetchFile,
      }), cb);
    } else {
      cb();
    }
  }

  /**
   * @param crawlmanager
   * @returns {boolean} True if have not already tried this page on this crawl.
   */
  isUniq(crawlmanager) {
    const key = [this.identifier, this.pageParms.page || this.pageParms.zip, this.pageParms.file, this.pageParms.scale, this.pageParms.rotate].join('/');
    const prevTasks = crawlmanager._uniqFiles[key];
    if (prevTasks) { return false; } else {
      crawlmanager._uniqFiles[key] = this;
      return true;
    }
  }
}

/**
 * Represents an item that needs crawling,
 *
 * identifier  Archive Identifier
 * identifier, level, query, search, related:  see config
 * member      Pointer to ArchiveMember if known
 * crawlmanager CrawlManager of this task
 */
class CrawlItem extends Crawlable {
  constructor({
    identifier = undefined, query = undefined, level = undefined, member = undefined, related = undefined, search = undefined, crawlmanager
  } = {}, parent) {
    if (identifier === '/') {
      identifier = 'home';
    } // Obsolete home identifier was "/" may not be used anywhere
    if ('identifier' === '' && !query) { identifier = 'home'; } // Obsolete home identifier was "/"
    super(identifier || query, parent);
    this.identifier = identifier;
    this.level = level;
    this.member = member;
    this.query = query;
    this.search = search;
    this.related = related;
    // Instead of setting this.query here, this.search_collection is set in fetch_metadata by specialidentifiers
    // if (this.identifier === "/" || this.identifier === "home" ||(this.identifier === "" && !this.query)) {
    //    this.identifier = "home"; this.debugname = "home"; this.query = homeQuery;
    // }
    if (['details', 'full'].includes(this.level)) {
      if (!this.search) this.search = crawlmanager.defaultDetailsSearch;
      if (!this.related) this.related = crawlmanager.defaultDetailsRelated;
    }
  }

  /**
   * Create a new CrawlItem and queue it, handles different kinds of members, including saved searches and those in fav-*
   * @param member
   * @param taskparms
   * @param parent
   * @param crawlmanager
   * @returns {CrawlItem}
   */
  static fromSearchMember(member, taskparms, parent, crawlmanager) {
    return new CrawlItem({
      member,
      crawlmanager,
      identifier: member.mediatype === 'search' ? undefined : member.identifier,
      level: taskparms.level,
      search: taskparms.search,
      related: taskparms.related,
      query: member.mediatype === 'search' ? member.identifier : undefined,
    }, parent);
  }

  _searchPageLessThanOrEqual(page1, page2) {
    return !page1
      || (page2
        && page1.sort === page2.sort
        && page1.rows === page2.rows
        && CrawlManager._levels.indexOf(page1.level) <= CrawlManager._levels.indexOf(page2.level)
        && this._searchLessThanOrEqual(page1.search, page2.search)
        && this._relatedLessThanOrEqual(page1.related, page2.related)
      );
  }

  _relatedLessThanOrEqual(rel1, rel2) {
    return !rel1
      || (rel2
        && rel1.rows <= rel2.rows
        && CrawlManager._levels.indexOf(rel1.level) <= CrawlManager._levels.indexOf(rel2.level)
        && this._searchLessThanOrEqual(rel1.search, rel2.search)
        && this._relatedLessThanOrEqual(rel1.related, rel2.related)
      );
  }

  _searchLessThanOrEqual(search1, search2) {
    return !search1
      || (search2
        && search1.length <= search2.length
        && search1.all((page, pageNo) => this._searchPageLessThanOrEqual(page, search2[pageNo])));
  }

  _lessThanOrEqual(task) {
    // return true if this.task is greater (more in depth) than task
    return (CrawlManager._levels.indexOf(this.level) <= CrawlManager._levels.indexOf(task.level))
      && this._searchLessThanOrEqual(this.search, task.search)
      && this._relatedLessThanOrEqual(this.related, task.related);
  }

  /**
   * @returns {boolean} True if the item has not been crawled this time at a greater or equal depth.
   */
  isUniq(crawlmanager) {
    const key = this.item._namepart();
    const prevTasks = crawlmanager._uniqItems[key];
    if (prevTasks) {
      if (prevTasks.some(task => this._lessThanOrEqual(task))) { // At least one task covered all material in this task
        return false;
      } else {
        crawlmanager._uniqItems[key].push({ level: this.level, search: this.search });
        return true;
      }
    } else {
      crawlmanager._uniqItems[key] = [{ level: this.level, search: this.search }]; // Explicitly not caching ArchiveItem as could get large in memory
      return true;
    }
  }

  /**
   * Crawl all the pages of a book
   * @param crawlmanager  CrawlManager
   * @param cb            cb(err)     synchronous, so currently called immediately
   */
  _crawlPages(crawlmanager, cb) {
    function _crawlPage(pageManifest, asParent, o) {
      crawlmanager._push(new CrawlPage({
        pageParms: this.item.pageParms(pageManifest, { ...o, skipNet: false }),
        identifier: this.item.identifier,
        archiveitem: this.item
      }, asParent));
    }
    const asParent = this.asParent();
    if (['details', 'all'].includes(this.level)) { // Details
      crawlmanager._push(new CrawlPage({
        identifier: this.item.identifier,
        archiveitem: this.item,
        pageParms: {
          page: 'cover_t.jpg',
        }
      }, asParent));
      this.item.pageManifests().forEach(pageManifest => {
        if (crawlmanager.crawlPalmLeaf && this.item.isPalmLeaf()) {
          _crawlPage.call(this, pageManifest, asParent, { idealWidth: 400 });
          _crawlPage.call(this, pageManifest, asParent, { idealWidth: 2000 });
          _crawlPage.call(this, pageManifest, asParent, { scale: 1 });
        } else {
          _crawlPage.call(this, pageManifest, asParent, { idealWidth: 800 });
        }
      });
    }
    cb();
  }

  /**
   * Process a task to crawl an item, complexity depends on its `.level` but can include fetch_metadata, fetch_query, saveThumbnail, crawling some or all of .files and relatedItems.
   */
  process(crawlmanager, cb) {
    debug('CrawlManager: processing "%s" %s via %o %o', this.debugname, this.level, this.parent, this.search || '');
    this.item = new ArchiveItem({ identifier: this.identifier, query: this.query });
    if (this.isUniq(crawlmanager)) {
      const skipFetchFile = crawlmanager.skipFetchFile;
      const noCache = crawlmanager.noCache;
      const copyDirectory = crawlmanager.copyDirectory;
      waterfall([
        (cb2) => { // Get metadata
          if (['metadata', 'details', 'all'].includes(this.level)) {
            this.item.fetch_metadata({ copyDirectory }, cb2);
          } else {
            cb2(null, this.item);
          }
        },
        (ai, cb2a) => { // Get bookreader metadata if its a book
          if (ai && ai.metadata && (ai.metadata.mediatype === 'texts') && (ai.subtype() === 'bookreader')) {
            ai.fetch_bookreader({ copyDirectory }, cb2a);
          } else {
            cb2a(null, this.item);
          }
        },
        (ai, cb3) => { // Save tile if level is set.
          if (['tile', 'metadata', 'details', 'all'].includes(this.level)) {
            (this.member || this.item).saveThumbnail({ skipFetchFile, copyDirectory, wantStream: false }, cb3);
          } else {
            cb3(null, this.item);
          }
        },
        (unused, cb4) => { // parameter Could be archiveItem or archiveSearchMember so dont use it
          // Find the minimum set of files and push to queue
          const asParent = this.asParent();
          if (this.identifier) { // (but only on items, not on searches)
            if (this.level === 'details') { // Details
              (this.item.minimumForUI({ crawlEpubs: crawlmanager.crawlEpubs && !this.item.isPalmLeaf() }) || []).forEach(af => crawlmanager._push(new CrawlFile({ file: af }, asParent)));
            } else if (this.level === 'all') { // Details - note tests maxFileSize before processing rather than before queuing
              if (this.item.files) this.item.files.forEach(af => crawlmanager._push(new CrawlFile({ file: af }, asParent)));
            }
          }
          cb4(null);
        },
        (cb4a) => { // If its a mediatype=bookreader subtype=bookreader get the pages
          if (this.item && this.item.metadata && (this.item.metadata.mediatype === 'texts') && (this.item.subtype() === 'bookreader')) {
            this._crawlPages(crawlmanager, cb4a);
          } else {
            cb4a();
          }
        },
        (cb5) => { // parameter Could be archiveItem or archiveSearchMember so dont use it
          // Get the related items
          if (this.identifier && (['details', 'all'].includes(this.level) || this.related)) {
            const taskparms = this.related || crawlmanager.defaultDetailsRelated;
            this.item.relatedItems({ copyDirectory, wantStream: false, wantMembers: true }, (err, searchmembers) => {
              if (err) {
                cb5(err);
              } else {
                each(searchmembers, (sm, cb5a) => sm.save({ copyDirectory }, cb5a), (unusederr) => { // Errors reported in save
                  searchmembers.slice(0, taskparms.rows)
                    .forEach(sm => crawlmanager._push(CrawlItem.fromSearchMember(sm, taskparms, this.asParent(), crawlmanager)));
                  cb5(null);
                });
              }
            });
          } else {
            cb5(null);
          }
        },
        (cb6) => {
          // If its a search or collection then do the query, and push members onto queue
          if (this.search && (this.query || (this.item && this.item.metadata && (this.item.metadata.mediatype === 'collection')))) {
            const ai = this.item;
            if (typeof ai.page === 'undefined') ai.page = 1;
            const search = Array.isArray(this.search) ? this.search : [this.search];
            ai.rows = search.reduce((acc, queryPage) => acc + queryPage.rows, 0); // Single query all rows
            ai.sort = Array.isArray(search[0].sort) ? search[0].sort : [search[0].sort];
            ai.fetch_query({ noCache, copyDirectory }, (err, searchMembers) => { // Needs to update start, but note opts can override start
              if (err) { cb6(err); } else {
                let start = 0;
                search.forEach(queryPage => {
                  if (queryPage.sort && (queryPage.sort !== this.item.sort[0])) {
                    // Note pushing error cos can only call cb6 once
                    const msg = `ERROR in configuration - Sorry, can't (yet) mix sort types in ${this.debugname} ignoring {queryPage.sort}`;
                    crawlmanager.errors.push({
                      task: this,
                      error: new Error(msg),
                      date: (new Date(Date.now()).toISOString())
                    });
                    debug(msg);
                  }
                  searchMembers.slice(start, start + queryPage.rows).forEach(sm => crawlmanager._push(
                    CrawlItem.fromSearchMember(sm, queryPage, this.asParent(), crawlmanager)
                  ));
                  start += queryPage.rows;
                });
                cb6();
              }
            });
          } else {
            cb6();
          }
        },
        // (cb) => { debug("XXX Finished processing item %s", this.identifier); cb(); }
      ], (err, res) => {
        if (err) {
          // Error is pushed in caller of .process()
          // crawlmanager.errors.push({task: task, error: err, date: (new Date(Date.now()).toISOString())});
          debug('Crawling item %s failed %o', this.identifier, err);
        }
        cb(err, res); // Pulled out on line by itself to make attaching breakpoint easier.
      });
    } else {
      cb();
    }
  }
}


exports = module.exports = CrawlManager;
