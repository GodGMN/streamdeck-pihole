import * as http from "http";
import * as https from "https";
import streamDeck, { SingletonAction } from "@elgato/streamdeck";

var instances = {}

// Helper function to make HTTP/HTTPS requests
function makeRequest(method, url, headers = {}, body = null, handler, allowInsecure = false) {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const options = {
        method: method,
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        headers: headers,
        timeout: 30000
    };
    
    if (isHttps && allowInsecure) {
        options.agent = new https.Agent({
            rejectUnauthorized: false
        });
    }
    
    const req = client.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
            data += chunk;
        });
        
        res.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                handler(parsed);
            } catch (e) {
                handler({ error: "Invalid JSON response" });
            }
        });
    });
    
    req.on('error', (err) => {
        handler({ error: err.message || "Network error" });
    });
    
    req.on('timeout', () => {
        req.destroy();
        handler({ error: "Request timeout" });
    });
    
    if (body) {
        req.write(JSON.stringify(body));
    }
    
    req.end();
}

// send message to Property Inspector
function sendToPropertyInspector(_context, payload){
    streamDeck.ui.current?.sendToPropertyInspector(payload);
}

// get auth token from pi-hole API that is valid until 5 min of inactivity
function pihole_connect(settings, handler){
    let req_addr = `${settings.protocol}://${settings.ph_addr}/api/auth`;
    // streamDeck.logger.info(`call request to ${req_addr}`);
    
    makeRequest('POST', req_addr, {
        'Content-Type': 'application/json'
    }, { password: settings.ph_key }, handler, settings.allow_insecure);
}

// delete pi-hole session since API seats are limited
function pihole_end({ settings, session }){
    if (session == null) return;
    let req_addr = `${settings.protocol}://${settings.ph_addr}/api/auth`;
    // streamDeck.logger.info(`call request to ${req_addr}`);
    
    makeRequest('DELETE', req_addr, {
        'X-FTL-SID': session.sid
    }, null, () => {}, settings.allow_insecure);
}

// make a call to check if pi-hole is enabled
function getBlockingStatus(settings, session, handler){
    let req_addr = `${settings.protocol}://${settings.ph_addr}/api/dns/blocking`;
    // streamDeck.logger.info(`call request to ${req_addr}`);
    
    makeRequest('GET', req_addr, {
        'X-FTL-SID': session.sid
    }, null, handler, settings.allow_insecure);
}

// make a call to enable or disable pi-hole
function setBlockingStatus(settings, session, enabled, timer){
    let req_addr = `${settings.protocol}://${settings.ph_addr}/api/dns/blocking`;
    // streamDeck.logger.info(`call request to ${req_addr}`);
    
    makeRequest('POST', req_addr, {
        'Content-Type': 'application/json',
        'X-FTL-SID': session.sid
    }, { blocking: enabled, timer }, () => {}, settings.allow_insecure);
}

// get stats for the pi-hole (# queries, # clients, etc.) and pass to a handler function
function getStatsSummary(settings, session, handler){
    let req_addr = `${settings.protocol}://${settings.ph_addr}/api/stats/summary`;
    // streamDeck.logger.info(`get_status request to ${req_addr}`);
    
    makeRequest('GET', req_addr, {
        'X-FTL-SID': session.sid
    }, null, handler, settings.allow_insecure);
}

// event handler for us.johnholbrook.pihole.temporarily-disable
function temporarily_disable(context){
    let { settings, session } = instances[context];
    getBlockingStatus(settings, session, response => {
        if (response.blocking == "enabled"){  // it only makes sense to temporarily disable p-h if it's currently enabled
            setBlockingStatus(settings, session, false, parseInt(settings.disable_time))
        }
    });
}

// event handler for us.johnholbrook.pihole.toggle
function toggle(context){
    let { settings, session } = instances[context];
    getBlockingStatus(settings, session, response => {
        if (response.blocking == "disabled"){
            setBlockingStatus(settings, session, true);
            setState(context, 0);
        }
        else if (response.blocking == "enabled"){
            setBlockingStatus(settings, session, false);
            setState(context, 1);
        }
    });
}

// event handler for us.johnholbrook.pihole.disable
function disable(context){
    let { settings, session } = instances[context];
    setBlockingStatus(settings, session, false);
}

// event handler for us.johnholbrook.pihole.enable
function enable(context){
    let { settings, session } = instances[context];
    setBlockingStatus(settings, session, true);
}

// poll p-h and set the state and button text appropriately
// (called once per second per instance)
function pollPihole(context){
    let { settings, session } = instances[context];
    getBlockingStatus(settings, session, response => {
        // streamDeck.logger.info(`response: ${JSON.stringify(response)}`)
        if ("error" in response){ // couldn't reach p-h, display a warning
            // streamDeck.logger.info(`${instances[context].action} error`)
            streamDeck.actions.getActionById(context)?.showAlert();
            streamDeck.logger.error(response);
        }
        else{
            // set state according to whether p-h is enabled or disabled
            if (response.blocking == "disabled" && settings.show_status){
                // streamDeck.logger.info(`${instances[context].action} offline`);
                streamDeck.actions.getActionById(context)?.setState(1);
            }
            else if (response.blocking == "enabled" && settings.show_status){
                // streamDeck.logger.info(`${instances[context].action} online`);
                streamDeck.actions.getActionById(context)?.setState(0);
            }

            // display stat, if desired
            if (settings.stat != "none"){
                getStatsSummary(settings, session, response => {
                    // streamDeck.logger.info(`response: ${JSON.stringify(response)}`)
                    if ("error" in response){
                        streamDeck.actions.getActionById(context)?.showAlert();
                        streamDeck.logger.error(response);
                    }
                    else{
                        // let stat = String(response[settings.stat]);
                        let stat = process_stat(response, settings.stat);
                        // streamDeck.logger.info(stat);
                        streamDeck.actions.getActionById(context)?.setTitle(stat);
                    }
                });
            }
        }
    });
}

// process the pi-hole stats to make them more human-readable,
// then cast to string
function process_stat(stats, type){
    switch (type){
        case "domains_being_blocked":
            return stats.gravity.domains_being_blocked.toLocaleString();
        case "dns_queries_today":
            return stats.queries.total.toLocaleString();
        case "ads_blocked_today":
            return stats.queries.blocked.toLocaleString();
        case "ads_percentage_today":
            return stats.queries.percent_blocked.toFixed(2) + "%";
        case "unique_domains":
            return stats.queries.unique_domains.toLocaleString();
        case "queries_forwarded":
            return stats.queries.forwarded.toLocaleString();
        case "queries_cached":
            return stats.queries.cached.toLocaleString();
        case "clients_ever_seen":
            return stats.clients.total.toLocaleString();
        case "unique_clients":
            return stats.clients.active.toLocaleString();
    }
}

// write settings
function writeSettings(context, action, settings){
    // write the settings
    if (!(context in instances)){ 
        instances[context] = {"action": action};
    }
    instances[context].settings = settings;
    if (instances[context].settings.ph_addr == ""){
        instances[context].settings.ph_addr = "pi.hole";
    }
    if (instances[context].settings.stat == "none"){
        streamDeck.actions.getActionById(context)?.setTitle("");
    }

    // clean up old p-h instance
    if ("poller" in instances[context]){
        clearInterval(instances[context].poller);
    }
    pihole_end(instances[context]);

    // poll p-h to get status
    instances[context].settings.show_status = true;
    const onReady = (response) => {
        // streamDeck.logger.info(`response: ${JSON.stringify(response)}`)
        if ("error" in response){
            streamDeck.actions.getActionById(context)?.showAlert();
            instances[context].errorState = response.error.message || response.error;
            sendToPropertyInspector(context, { error: instances[context].errorState });
            streamDeck.logger.error(response);
        } else{
            instances[context].errorState = false;
            sendToPropertyInspector(context, { success: true });
            instances[context].session = response.session;
            instances[context].poller = setInterval(() => {
                const timeNow = Math.floor(Date.now() / 1000);
                const sessionExpired = "lastUpdateTime" in instances[context] &&
                    (timeNow - instances[context].lastUpdateTime) > instances[context].session.validity;
                instances[context].lastUpdateTime = timeNow;
                if (sessionExpired){
                    clearInterval(instances[context].poller);
                    pihole_connect(instances[context].settings, onReady);
                } else{
                    pollPihole(context);
                }
            }, Math.ceil(response.took) * 1000);
        }
        // streamDeck.logger.info(JSON.stringify(instances));
    }
    pihole_connect(instances[context].settings, onReady);
}

// Pi-hole Stream Deck Action
class PiholeAction extends SingletonAction {
    constructor(manifestId, handler) {
        super();
        this.manifestId = manifestId;
        this.handler = handler;
    }

    onWillAppear(ev) {
        writeSettings(ev.action.id, this.manifestId, ev.payload.settings);
    }
    
    onWillDisappear(ev) {
        const contextId = ev.action.id;
        if (contextId in instances){
            if ("poller" in instances[contextId]){
                clearInterval(instances[contextId].poller);
            }
            pihole_end(instances[contextId]);
            delete instances[contextId];
        }
    }
    
    onDidReceiveSettings(ev) {
        writeSettings(ev.action.id, this.manifestId, ev.payload.settings);
    }
    
    onSendToPlugin(ev) {
        const contextId = ev.action.id;
        if (ev.payload && ev.payload.action === "getErrorState"){
            // Send current error state if it exists
            if (contextId in instances){
                sendToPropertyInspector(contextId, instances[contextId].errorState ? {
                    error: instances[contextId].errorState
                } : { success: instances[contextId].errorState === false });
            }
        } else if (ev.payload && ev.payload.action === "retryConnection"){
            // Retry connection by re-initializing the instance
            if (contextId in instances){
                writeSettings(contextId, instances[contextId].action, instances[contextId].settings);
            }
        }
    }
    
    onKeyUp(ev) {
        const contextId = ev.action.id;
        this.handler(contextId);
    }
}

// Clean up all sessions when plugin exits
let cleaned = false;
function cleanup(){
    if (cleaned) return;
    cleaned = true;
    // streamDeck.logger.info("exiting now");
    Object.values(instances).forEach(pihole_end);
}
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

// Register and connect
actions = {
    "us.johnholbrook.pihole.toggle": toggle,
    "us.johnholbrook.pihole.temporarily-disable": temporarily_disable,
    "us.johnholbrook.pihole.disable": disable,
    "us.johnholbrook.pihole.enable": enable
}
for (const [id, handler] of Object.entries(actions)) {
    streamDeck.actions.registerAction(new PiholeAction(id, handler));
}
streamDeck.connect();
