import Debug from 'debug';

const debug = Debug('lt:diagnostics');

export function gatherStats(manager) {
    const mem = process.memoryUsage();
    const tunnelCount = manager.stats.tunnels;

    let totalWaiting = 0;
    let totalAvailable = 0;
    let totalAgentQueued = 0;
    let totalConnected = 0;
    let maxWaiting = 0;
    let maxAgentQueued = 0;

    for (const [, client] of manager.clients) {
        const agent = client.agent;
        const waiting = agent.waitingCreateConn.length;
        const available = agent.availableSockets.length;
        const connected = agent.connectedSockets;

        // http.Agent internal pending requests
        let agentQueued = 0;
        if (agent.requests) {
            for (const key in agent.requests) {
                agentQueued += agent.requests[key].length;
            }
        }

        totalWaiting += waiting;
        totalAvailable += available;
        totalAgentQueued += agentQueued;
        totalConnected += connected;
        maxWaiting = Math.max(maxWaiting, waiting);
        maxAgentQueued = Math.max(maxAgentQueued, agentQueued);
    }

    return {
        tunnels: tunnelCount,
        heapMB: (mem.heapUsed / 1048576).toFixed(1),
        rssMB: (mem.rss / 1048576).toFixed(1),
        perTunnelKB: tunnelCount > 0
            ? ((mem.heapUsed / tunnelCount) / 1024).toFixed(1)
            : '0',
        totalConnected,
        totalAvailable,
        totalWaiting,
        maxWaiting,
        totalAgentQueued,
        maxAgentQueued,
    };
}

export function startDiagnostics(manager, intervalMs = 30000) {
    const intervalId = setInterval(() => {
        const stats = gatherStats(manager);
        debug(JSON.stringify({ ts: new Date().toISOString(), ...stats }));
    }, intervalMs).unref();

    return intervalId;
}
