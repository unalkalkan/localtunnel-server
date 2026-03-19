import { Agent } from 'http';
import net from 'net';
import assert from 'assert';
import log from 'book';
import Debug from 'debug';
import ipaddr from 'ipaddr.js';

const debug = Debug('lt:TunnelAgent');

const DEFAULT_MAX_SOCKETS = 10;
const DEFAULT_MAX_WAITING = 10;
const DEFAULT_WAITING_TIMEOUT = 10000; // 10s

// Passive timeout from https://github.com/StyleT/mytunnel-server
const DEFAULT_SOCKET_TIMEOUT = 15 * 60 * 1000;

// Fetches the public IP address of the server
var PUBLIC_IP = null;
async function getPublicIPv4() {
    const response = await fetch('https://ipv4.icanhazip.com/');
    if (!response.ok) {
        return null;
    }
    const ip = await response.text();
    return ip.trim();
}

// Implements an http.Agent interface to a pool of tunnel sockets
// A tunnel socket is a connection _from_ a client that will
// service http requests. This agent is usable wherever one can use an http.Agent
class TunnelAgent extends Agent {
    constructor(options = {}) {
        super({
            keepAlive: true,
            // only allow keepalive to hold on to one socket
            // this prevents it from holding on to all the sockets so they can be used for upgrades
            maxFreeSockets: 1,
        });

        // sockets we can hand out via createConnection
        this.availableSockets = [];

        // when a createConnection cannot return a socket, it goes into a queue
        // once a socket is available it is handed out to the next callback
        this.waitingCreateConn = [];

        this.clientId = options.clientId;

        // track maximum allowed sockets
        this.connectedSockets = 0;
        this.maxTcpSockets = options.maxTcpSockets || DEFAULT_MAX_SOCKETS;

        // new tcp server to service requests for this client
        this.server = net.createServer();

        this._socketTimeout = options.socketTimeout || DEFAULT_SOCKET_TIMEOUT;

        // flag to avoid double starts
        this.started = false;
        this.closed = false;

        this.agentIps = [];
    }

    stats() {
        return {
            connectedSockets: this.connectedSockets,
        };
    }

    listen() {
        if (this.started) {
            throw new Error('already started');
        }
        this.started = true;

        this.server.on('close', this._onClose.bind(this));
        this.server.on('connection', this._onConnection.bind(this));
        this.server.on('error', (err) => {
            // These errors happen from killed connections, we don't worry about them
            if (err.code == 'ECONNRESET' || err.code == 'ETIMEDOUT') {
                return;
            }
            log.error(err);
        });

        return new Promise((resolve) => {
            this.server.listen(async () => {
                const port = this.server.address().port;
                debug('[%s] tcp server listening on port: %d', this.clientId, port);

                const info = {
                    // port for lt client tcp connections
                    port: port,
                };

                if (!PUBLIC_IP) PUBLIC_IP = await getPublicIPv4();

                if (PUBLIC_IP) info.publicIp = PUBLIC_IP;

                resolve(info);
            });
        });
    }

    _onClose() {
        this.closed = true;
        debug('[%s] closed tcp socket', this.clientId);
        // flush any waiting connections
        for (const conn of this.waitingCreateConn) {
            conn(new Error('closed'), null);
        }
        this.waitingCreateConn = [];
        this.emit('end');
    }

    // new socket connection from client for tunneling requests to client
    _onConnection(socket) {
        socket.setTimeout(this._socketTimeout);

        // no more socket connections allowed
        if (this.connectedSockets >= this.maxTcpSockets) {
            debug('[%s] no more sockets allowed', this.clientId);
            socket.destroy();
            return false;
        }

        socket.once('timeout', () => {
            debug('[%s] socket timeout', this.clientId);
            socket.destroy();
        });

        socket.once('close', (hadError) => {
            debug('[%s] closed socket (error: %s)', this.clientId, hadError);
            this.connectedSockets -= 1;
            // remove the socket from available list
            const idx = this.availableSockets.indexOf(socket);
            if (idx >= 0) {
                this.availableSockets.splice(idx, 1);
            }

            debug('[%s] connected sockets: %s', this.clientId, this.connectedSockets);
            if (this.connectedSockets <= 0) {
                debug('[%s] all sockets disconnected', this.clientId);
                this.emit('offline');
            }
        });

        // close will be emitted after this
        socket.once('error', (err) => {
            // we do not log these errors, sessions can drop from clients for many reasons
            // these are not actionable errors for our server
            socket.destroy();
        });

        if (this.connectedSockets === 0) {
            this.emit('online');
        }

        // check & parse remote ip address
        let ipString = socket.remoteAddress;
        let agentIp = null;

        if (ipaddr.IPv4.isValid(ipString)) {
            agentIp = ipString; // IPv4 address
        } else if (ipaddr.IPv6.isValid(ipString)) {
            var ip = ipaddr.IPv6.parse(ipString);
            if (ip.isIPv4MappedAddress()) {
                agentIp = ip.toIPv4Address().toString(); // get IPv4 address
            } else {
                agentIp = ip.toNormalizedString(); // IPv6 address
            }
        } else {
            // ipString is invalid so ignore
            // TODO: should we disconnect socket if this happens?
        }

        // save agent's sanitized IP
        if (!!agentIp && this.agentIps.indexOf(agentIp) == -1) {
            this.agentIps.push(agentIp);
        }

        this.connectedSockets += 1;
        debug(
            '[%s] new connection from %s:%s to %s:%s',
            this.clientId,
            socket.remoteAddress,
            socket.remotePort,
            socket.address().address,
            socket.address().port,
        );

        // if there are queued callbacks, give this socket now and don't queue into available
        const fn = this.waitingCreateConn.shift();
        if (fn) {
            debug('[%s] giving socket to queued conn request', this.clientId);
            setTimeout(() => {
                fn(null, socket);
            }, 0);
            return;
        }

        // make socket available for those waiting on sockets
        this.availableSockets.push(socket);
    }

    // fetch a socket from the available socket pool for the agent
    // if no socket is available, queue
    // cb(err, socket)
    createConnection(options, cb) {
        if (this.closed) {
            cb(new Error('closed'));
            return;
        }

        debug('[%s] create connection', this.clientId);

        // socket is a tcp connection back to the user hosting the site
        const sock = this.availableSockets.shift();

        // no available sockets
        // wait until we have one, with a timeout to prevent unbounded queuing
        if (!sock) {
            if (this.waitingCreateConn.length >= DEFAULT_MAX_WAITING) {
                debug('[%s] too many waiting connections (%d), rejecting', this.clientId, this.waitingCreateConn.length);
                cb(new Error('too many pending tunnel requests'));
                return;
            }

            const timeoutId = setTimeout(() => {
                const idx = this.waitingCreateConn.indexOf(wrappedCb);
                if (idx >= 0) {
                    this.waitingCreateConn.splice(idx, 1);
                    debug('[%s] waiting connection timed out', this.clientId);
                    cb(new Error('no available tunnel sockets (timeout)'));
                }
            }, DEFAULT_WAITING_TIMEOUT);

            const wrappedCb = (err, socket) => {
                clearTimeout(timeoutId);
                cb(err, socket);
            };

            this.waitingCreateConn.push(wrappedCb);
            debug('[%s] waiting connected: %s', this.clientId, this.connectedSockets);
            debug('[%s] waiting available: %s', this.clientId, this.availableSockets.length);
            return;
        }

        debug('[%s] socket given', this.clientId);
        cb(null, sock);
    }

    drain() {
        this.server.close();
    }

    destroy() {
        this.server.close();
        super.destroy();
    }
}

export default TunnelAgent;
