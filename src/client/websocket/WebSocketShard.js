'use strict';

const EventEmitter = require('events');
const WebSocket = require('../../WebSocket');
const { Status, Events, ShardEvents, OPCodes, WSEvents } = require('../../util/Constants');

let zlib;
try {
  zlib = require('zlib-sync');
  if (!zlib.Inflate) zlib = require('pako');
} catch (err) {
  zlib = require('pako');
}

/**
 * Represents a Shard's WebSocket connection
 */
class WebSocketShard extends EventEmitter {
  constructor(manager, id) {
    super();

    /**
     * The WebSocketManager of this shard
     * @type {WebSocketManager}
     */
    this.manager = manager;

    /**
     * The ID of this shard
     * @type {number}
     */
    this.id = id;

    /**
     * The current status of the shard
     * @type {Status}
     */
    this.status = Status.IDLE;

    /**
     * The current sequence of the shard
     * @type {number}
     * @private
     */
    this.sequence = -1;

    /**
     * The sequence of the shard after close
     * @type {number}
     * @private
     */
    this.closeSequence = 0;

    /**
     * The current session ID of the shard
     * @type {string}
     * @private
     */
    this.sessionID = undefined;

    /**
     * The previous 3 heartbeat pings of the shard (most recent first)
     * @type {number[]}
     */
    this.pings = [];

    /**
     * The last time a ping was sent (a timestamp)
     * @type {number}
     * @private
     */
    this.lastPingTimestamp = -1;

    /**
     * If we received a heartbeat ack back. Used to identify zombie connections
     * @type {boolean}
     * @private
     */
    this.lastHeartbeatAcked = true;

    /**
     * List of servers the shard is connected to
     * @type {string[]}
     * @private
     */
    this.trace = [];

    /**
     * Contains the rate limit queue and metadata
     * @type {Object}
     * @private
     */
    this.ratelimit = {
      queue: [],
      total: 120,
      remaining: 120,
      time: 60e3,
      timer: null,
    };

    // TODO: Hidden
    /**
     * The WebSocket connection for the current shard
     * @type {?WebSocket}
     * @private
     */
    this.connection = null;

    /**
     * @external Inflate
     * @see {@link https://www.npmjs.com/package/zlib-sync}
     */

    // TODO: Hidden
    /**
     * The compression to use
     * @type {?Inflate}
     * @private
     */
    this.inflate = null;

    // TODO: Hidden
    /**
     * The HELLO timeout
     * @type {?NodeJS.Timer}
     * @private
     */
    this.helloTimeout = undefined;

    // TODO: Hidden
    /**
     * If the manager attached its event handlers on this shard
     * @type {boolean}
     * @private
     */
    this.eventsAttached = false;
  }

  /**
   * Average heartbeat ping of the websocket, obtained by averaging the WebSocketShard#pings property
   * @type {number}
   * @readonly
   */
  get ping() {
    const sum = this.pings.reduce((a, b) => a + b, 0);
    return sum / this.pings.length;
  }

  /**
   * Emits a debug event.
   * @param {string} message The debug message
   * @private
   */
  debug(message) {
    this.manager.debug(message, this);
  }

  /**
   * Connects this shard to the gateway.
   * @private
   * @returns {Promise<boolean>} A promise that will resolve if the shard turns ready successfully,
   * or reject if we couldn't connect
   */
  connect() {
    const { gateway, client } = this.manager;

    this.inflate = new zlib.Inflate({
      chunkSize: 65535,
      flush: zlib.Z_SYNC_FLUSH,
      to: WebSocket.encoding === 'json' ? 'string' : '',
    });

    return new Promise((resolve, reject) => {
      const onReady = () => {
        this.off(ShardEvents.CLOSE, onClose);
        this.off(ShardEvents.RESUMED, onResumed);
        resolve();
      };

      const onResumed = () => {
        this.off(ShardEvents.CLOSE, onClose);
        this.off(ShardEvents.READY, onReady);
        resolve();
      };

      const onClose = event => {
        this.off(ShardEvents.READY, onReady);
        this.off(ShardEvents.RESUMED, onResumed);
        reject(event);
      };

      this.once(ShardEvents.READY, onReady);
      this.once(ShardEvents.RESUMED, onResumed);
      this.once(ShardEvents.CLOSE, onClose);

      this.debug(`Trying to connect to ${gateway}, version ${client.options.ws.version}`);

      this.status = this.status === Status.DISCONNECTED ? Status.RECONNECTING : Status.CONNECTING;
      this.setHelloTimeout();

      const ws = this.connection = WebSocket.create(gateway, {
        v: client.options.ws.version,
        compress: 'zlib-stream',
      });
      ws.onopen = this.onOpen.bind(this);
      ws.onmessage = this.onMessage.bind(this);
      ws.onerror = this.onError.bind(this);
      ws.onclose = this.onClose.bind(this);
    });
  }

  /**
   * Called whenever a connection is opened to the gateway.
   * @private
   */
  onOpen() {
    this.debug('Opened a connection to the gateway successfully.');
    this.status = Status.NEARLY;
  }

  /**
   * Called whenever a message is received.
   * @param {Event} event Event received
   * @private
   */
  onMessage({ data }) {
    if (data instanceof ArrayBuffer) data = new Uint8Array(data);
    const l = data.length;
    const flush = l >= 4 &&
      data[l - 4] === 0x00 &&
      data[l - 3] === 0x00 &&
      data[l - 2] === 0xFF &&
      data[l - 1] === 0xFF;

    this.inflate.push(data, flush && zlib.Z_SYNC_FLUSH);
    if (!flush) return;
    try {
      const packet = WebSocket.unpack(this.inflate.result);
      this.manager.client.emit(Events.RAW, packet, this.id);
      this.onPacket(packet);
    } catch (err) {
      this.manager.client.emit(Events.SHARD_ERROR, err, this.id);
    }
  }

  /**
   * Called whenever an error occurs with the WebSocket.
   * @param {Error} error The error that occurred
   * @private
   */
  onError(error) {
    if (error && error.message === 'uWs client connection error') {
      this.debug('Received a uWs error. Closing the connection and reconnecting...');
      this.connection.close(4000);
      return;
    }

    /**
     * Emitted whenever a shard's WebSocket encounters a connection error.
     * @event Client#shardError
     * @param {Error} error The encountered error
     * @param {number} shardID The shard that encountered this error
     */
    this.manager.client.emit(Events.SHARD_ERROR, error, this.id);
  }

  /**
   * @external CloseEvent
   * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent}
   */

  /**
   * Called whenever a connection to the gateway is closed.
   * @param {CloseEvent} event Close event that was received
   * @private
   */
  onClose(event) {
    this.closeSequence = this.sequence;
    this.sequence = -1;
    this.debug(`WebSocket was closed.
      Event Code: ${event.code}
      Reason: ${event.reason || 'No reason received'}`);

    this.status = Status.DISCONNECTED;

    /**
     * Emitted when a shard's WebSocket closes.
     * @private
     * @event WebSocketShard#close
     * @param {CloseEvent} event The received event
     */
    this.emit(ShardEvents.CLOSE, event);
  }

  /**
   * Called whenver a packet is received.
   * @param {Object} packet The packet
   * @private
   */
  onPacket(packet) {
    if (!packet) {
      this.debug(`Received broken packet: ${packet}.`);
      return;
    }

    switch (packet.t) {
      case WSEvents.READY:
        /**
         * Emitted when the shard becomes ready
         * @event WebSocketShard#ready
         */
        this.emit(ShardEvents.READY);

        this.sessionID = packet.d.session_id;
        this.trace = packet.d._trace;
        this.status = Status.READY;
        this.debug(`READY ${this.trace.join(' -> ')} | Session ${this.sessionID}.`);
        this.lastHeartbeatAcked = true;
        this.sendHeartbeat();
        break;
      case WSEvents.RESUMED: {
        /**
         * Emitted when the shard resumes successfully
         * @event WebSocketShard#resumed
         */
        this.emit(ShardEvents.RESUMED);

        this.trace = packet.d._trace;
        this.status = Status.READY;
        const replayed = packet.s - this.closeSequence;
        this.debug(`RESUMED ${this.trace.join(' -> ')} | Session ${this.sessionID} | Replayed ${replayed} events.`);
        this.lastHeartbeatAcked = true;
        this.sendHeartbeat();
      }
    }

    if (packet.s > this.sequence) this.sequence = packet.s;

    switch (packet.op) {
      case OPCodes.HELLO:
        this.setHelloTimeout(-1);
        this.setHeartbeatTimer(packet.d.heartbeat_interval);
        this.identify();
        break;
      case OPCodes.RECONNECT:
        this.connection.close(1001);
        break;
      case OPCodes.INVALID_SESSION:
        this.debug(`Session invalidated. Resumable: ${packet.d}.`);
        // If we can resume the session, do so immediately
        if (packet.d) {
          this.identifyResume();
          return;
        }
        // Reset the sequence
        this.sequence = -1;
        // Reset the session ID as it's invalid
        this.sessionID = null;
        // Finally, close the connection
        this.connection.close(1000);
        break;
      case OPCodes.HEARTBEAT_ACK:
        this.ackHeartbeat();
        break;
      case OPCodes.HEARTBEAT:
        this.sendHeartbeat();
        break;
      default:
        this.manager.handlePacket(packet, this);
    }
  }

  /**
   * Sets the HELLO packet timeout.
   * @param {number} [time=20000] The delay to wait for the packet. If set to -1, will clear the timeout
   * @private
   */
  setHelloTimeout(time = 20000) {
    if (time === -1 && this.helloTimeout) {
      this.debug('Clearing the HELLO timeout.');
      clearTimeout(this.helloTimeout);
    } else {
      this.debug('Setting a HELLO timeout for 20s.');
      this.helloTimeout = setTimeout(() => {
        this.debug('Did not receive HELLO in time. Destroying and connecting again.');
        this.destroy(4009);
      }, time);
    }
  }

  /**
   * Sets the heartbeat timer for this shard.
   * @param {number} time If -1, clears the interval, any other number sets an interval
   * @private
   */
  setHeartbeatTimer(time) {
    if (time === -1) {
      if (this.heartbeatInterval) {
        this.debug('Clearing the heartbeat interval.');
        this.manager.client.clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      return;
    }
    this.debug(`Setting a heartbeat interval for ${time}ms.`);
    this.heartbeatInterval = this.manager.client.setInterval(() => this.sendHeartbeat(), time);
  }

  /**
   * Sends a heartbeat to the WebSocket.
   * If this shard didn't receive a heartbeat last time, it will destroy it and reconnect
   * @private
   */
  sendHeartbeat() {
    if (!this.lastHeartbeatAcked) {
      this.debug("Didn't receive a heartbeat ack last time, assuming zombie conenction. Destroying and reconnecting.");
      this.connection.close(4009);
      return;
    }
    this.debug('Sending a heartbeat.');
    this.lastHeartbeatAcked = false;
    this.lastPingTimestamp = Date.now();
    this.send({ op: OPCodes.HEARTBEAT, d: this.sequence }, true);
  }

  /**
   * Acknowledges a heartbeat.
   * @private
   */
  ackHeartbeat() {
    this.lastHeartbeatAcked = true;
    const latency = Date.now() - this.lastPingTimestamp;
    this.debug(`Heartbeat acknowledged, latency of ${latency}ms.`);
    this.pings.unshift(latency);
    if (this.pings.length > 3) this.pings.length = 3;
  }

  /**
   * Identifies the client on the connection.
   * @private
   * @returns {void}
   */
  identify() {
    return this.sessionID ? this.identifyResume() : this.identifyNew();
  }

  /**
   * Identifies as a new connection on the gateway.
   * @private
   */
  identifyNew() {
    const { client } = this.manager;
    if (!client.token) {
      this.debug('No token available to identify a new session.');
      return;
    }

    // Close the identify payload and assign the token and shard info
    const d = {
      ...client.options.ws,
      token: client.token,
      shard: [this.id, Number(client.options.totalShardCount)],
    };

    this.debug(`Identifying as a new session. Shard ${this.id}/${client.options.totalShardCount}`);
    this.send({ op: OPCodes.IDENTIFY, d }, true);
  }

  /**
   * Resumes a session on the gateway.
   * @private
   */
  identifyResume() {
    if (!this.sessionID) {
      this.debug('Warning: attempted to resume but no session ID was present; identifying as a new session.');
      this.identifyNew();
      return;
    }

    this.debug(`Attempting to resume session ${this.sessionID} at sequence ${this.closeSequence}`);

    const d = {
      token: this.manager.client.token,
      session_id: this.sessionID,
      seq: this.closeSequence,
    };

    this.send({ op: OPCodes.RESUME, d }, true);
  }

  /**
   * Adds a packet to the queue to be sent.
   * @param {Object} data The full packet to send
   * @param {?boolean} [important=false] If this packet should be added first in queue
   */
  send(data, important = false) {
    this.ratelimit.queue[important ? 'unshift' : 'push'](data);
    this.processQueue();
  }

  /**
   * Sends data, bypassing the queue.
   * @param {Object} data Packet to send
   * @returns {void}
   * @private
   */
  _send(data) {
    if (!this.connection || this.connection.readyState !== WebSocket.OPEN) {
      this.debug(`Tried to send packet ${JSON.stringify(data)} but no WebSocket is available!`);
      return;
    }

    this.connection.send(WebSocket.pack(data), err => {
      if (err) this.manager.client.emit(Events.SHARD_ERROR, err, this.id);
    });
  }

  /**
   * Processes the current WebSocket queue.
   * @returns {void}
   * @private
   */
  processQueue() {
    if (this.ratelimit.remaining === 0) return;
    if (this.ratelimit.queue.length === 0) return;
    if (this.ratelimit.remaining === this.ratelimit.total) {
      this.ratelimit.timer = this.manager.client.setTimeout(() => {
        this.ratelimit.remaining = this.ratelimit.total;
        this.processQueue();
      }, this.ratelimit.time);
    }
    while (this.ratelimit.remaining > 0) {
      const item = this.ratelimit.queue.shift();
      if (!item) return;
      this._send(item);
      this.ratelimit.remaining--;
    }
  }

  /**
   * Destroys this shard and closes its WebSocket connection.
   * @param {?number} [closeCode=1000] The close code to use
   * @private
   */
  destroy(closeCode = 1000) {
    this.setHeartbeatTimer(-1);
    this.setHelloTimeout(-1);
    // Close the WebSocket connection, if any
    if (this.connection) this.connection.close(closeCode);
    this.connection = null;
    // Set the shard status
    this.status = Status.DISCONNECTED;
    // Reset the sequence
    this.sequence = -1;
    // Reset the ratelimit data
    this.ratelimit.remaining = this.ratelimit.total;
    this.ratelimit.queue.length = 0;
    if (this.ratelimit.timer) {
      this.manager.client.clearTimeout(this.ratelimit.timer);
      this.ratelimit.timer = null;
    }
  }
}

module.exports = WebSocketShard;
