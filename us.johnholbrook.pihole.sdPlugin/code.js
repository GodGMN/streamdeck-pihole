var websocket = null;
var instances = {}

// send some data over the websocket
function send(data){
    websocket.send(JSON.stringify(data));
}

// write to the log
function log(message){
    send({
        "event": "logMessage",
        "payload": {
            "message": message
        }
    });
}

// get auth token from pi-hole API that is valid until 5 min of inactivity
function pihole_connect(settings, handler){
    let req_addr = `${settings.protocol}://${settings.ph_addr}/api/auth`;
    // log(`call request to ${req_addr}`);
    let xhr = new XMLHttpRequest();
    xhr.timeout = 30000;
    xhr.open("POST", req_addr);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onload = function(){
        let data = JSON.parse(xhr.response);
        handler(data);
    }
    xhr.onerror = xhr.ontimeout = function(){
        handler({"error": "couldn't authenticate to Pi-hole"});
    }
    xhr.send(JSON.stringify({ password: settings.ph_key }));
}

// delete pi-hole session since API seats are limited
function pihole_end({ settings, session }){
    if (session == null) return;
    let req_addr = `${settings.protocol}://${settings.ph_addr}/api/auth`;
    let xhr = new XMLHttpRequest();
    xhr.timeout = 5000;
    xhr.open("DELETE", req_addr);
    xhr.setRequestHeader("X-FTL-SID", session.sid);
    xhr.send();
}

// make a call to check if pi-hole is enabled
function getBlockingStatus(settings, session, handler){
    let req_addr = `${settings.protocol}://${settings.ph_addr}/api/dns/blocking`;
    let xhr = new XMLHttpRequest();
    xhr.timeout = 5000;
    xhr.open("GET", req_addr);
    xhr.setRequestHeader("X-FTL-SID", session.sid);
    xhr.onload = function(){
        let data = JSON.parse(xhr.response);
        handler(data);
    }
    xhr.onerror = xhr.ontimeout = function(){
        handler({"error": "couldn't reach Pi-hole"});
    }
    xhr.send();
}

// make a call to enable or disable pi-hole
function setBlockingStatus(settings, session, enabled, timer){
    let req_addr = `${settings.protocol}://${settings.ph_addr}/api/dns/blocking`;
    // log(`call request to ${req_addr}`);
    let xhr = new XMLHttpRequest();
    xhr.open("POST", req_addr);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("X-FTL-SID", session.sid);
    xhr.send(JSON.stringify({ blocking: enabled, timer }));
}

// get stats for the pi-hole (# queries, # clients, etc.) and pass to a handler function
function getStatsSummary(settings, session, handler){
    let req_addr = `${settings.protocol}://${settings.ph_addr}/api/stats/summary`;
    let xhr = new XMLHttpRequest();
    xhr.timeout = 5000;
    xhr.open("GET", req_addr);
    xhr.setRequestHeader("X-FTL-SID", session.sid);
    xhr.onload = function(){
        let data = JSON.parse(xhr.response);
        handler(data);
    }
    xhr.onerror = xhr.ontimeout = function(){
        handler({"error": "couldn't reach Pi-hole"});
    }
    xhr.send();
}

// event handler for us.johnholbrook.pihole.temporarily-disable
function temporarily_disable(context){
    let { settings, session } = instances[context];
    getBlockingStatus(settings, session, response => {
        if (response.blocking == "enabled"){  // it only makes sense to temporarily disable p-h if it's currently enabled
            setBlockingStatus(settings, session, false, parseInt(settings.disable_time) || 300)
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
function pollPihole(context){
    if (instances[context].polling) return;
    instances[context].polling = true;
    let { settings, session } = instances[context];
    getBlockingStatus(settings, session, response => {
        if (instances[context]) instances[context].polling = false;
        // log(`response: ${JSON.stringify(response)}`)
        if ("error" in response){ // couldn't reach p-h, display a warning
            // log(`${instances[context].action} error`)
            send({
                "event": "showAlert",
                "context": context
            });
            log(response);
        }
        else{
            // set state according to whether p-h is enabled or disabled
            if (response.blocking == "disabled" && settings.show_status){
                // log(`${instances[context].action} offline`);
                setState(context, 1);
            }
            else if (response.blocking == "enabled" && settings.show_status){
                // log(`${instances[context].action} online`);
                setState(context, 0);
            }

            // display stat, if desired
            if (settings.stat != "none"){
                getStatsSummary(settings, session, response => {
                    // log(`response: ${JSON.stringify(response)}`)
                    if ("error" in response){
                        send({
                            "event": "showAlert",
                            "context": context
                        });
                        log(response);
                    }
                    else{
                        // let stat = String(response[settings.stat]);
                        let stat = process_stat(response, settings.stat);
                        // log(stat);
                        send({
                            "event": "setTitle",
                            "context": context,
                            "payload": {
                                "title": stat
                            }
                        });
                    }
                });
            }
        }
    });
}

// process the pi-hole stats to make them more human-readable,
// then cast to string
function process_stat(stats, type){
    try {
        switch (type){
            case "domains_being_blocked":
                return stats.gravity.domains_being_blocked.toLocaleString();
            case "dns_queries_today":
                return stats.queries.total.toLocaleString();
            case "ads_blocked_today":
                return stats.queries.blocked.toLocaleString();
            case "ads_percentage_today":
                return (stats.queries.percent_blocked ?? 0).toFixed(2) + "%";
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
            default:
                return "?";
        }
    } catch(e) {
        log(`process_stat error for "${type}": ${e.message}. Response: ${JSON.stringify(stats)}`);
        return "?";
    }
}

// change the state of a button (param "state" should be either 0 or 1)
function setState(context, state){
    let json = {
        "event" : "setState",
        "context" : context,
        "payload" : {
            "state" : state
        }
    };
    websocket.send(JSON.stringify(json));
}

// write settings
function writeSettings(context, action, settings){
    if (!(context in instances)){
        instances[context] = {"action": action};
    }
    const inst = instances[context];
    inst.settings = settings;
    if (inst.settings.ph_addr == ""){
        inst.settings.ph_addr = "pi.hole";
    }
    if (inst.settings.stat == "none"){
        send({
            "event": "setTitle",
            "context": context,
            "payload": {
                "title": ""
            }
        });
    }

    // Skip reconnect if connection parameters haven't changed and a session exists.
    // This prevents a double-connect when willAppear and didReceiveSettings both fire on load.
    const connKey = `${settings.protocol}://${inst.settings.ph_addr}:${settings.ph_key}`;
    if (inst.connKey === connKey && inst.session) return;
    inst.connKey = connKey;

    // clean up old p-h instance
    if ("poller" in inst){
        clearInterval(inst.poller);
    }
    pihole_end(inst);

    inst.settings.show_status = true;
    const onReady = (response) => {
        if ("error" in response){
            send({
                "event": "showAlert",
                "context": context
            });
            log(response);
        } else{
            inst.session = response.session;
            inst.sessionCreatedAt = Math.floor(Date.now() / 1000);
            inst.poller = setInterval(() => {
                const timeNow = Math.floor(Date.now() / 1000);
                const sessionExpired = (timeNow - inst.sessionCreatedAt) > inst.session.validity;
                if (sessionExpired){
                    clearInterval(inst.poller);
                    pihole_connect(inst.settings, onReady);
                } else{
                    pollPihole(context);
                }
            }, 5000);
        }
    }
    pihole_connect(inst.settings, onReady);
}

// called by the stream deck software when the plugin is initialized
function connectElgatoStreamDeckSocket(inPort, inPluginUUID, inRegisterEvent, inInfo){
    // create the websocket
    websocket = new WebSocket("ws://localhost:" + inPort);
    websocket.onopen = function(){
        // WebSocket is connected, register the plugin
        var json = {
            "event": inRegisterEvent,
            "uuid": inPluginUUID
        };
        websocket.send(JSON.stringify(json));
    };
    websocket.onclose = function(){
        // log("exiting now");
        for (const instance of Object.values(instances)){
            pihole_end(instance);
        }
    };

    // message handler
    websocket.onmessage = function(evt){
        let jsonObj = JSON.parse(evt.data);
        let event = jsonObj.event;
        let action = jsonObj.action;
        let context = jsonObj.context;

        // log(`${action} ${event}`);
        // console.log(`${action} ${event}`);

        // update settings for this instance
        if (event == "didReceiveSettings"){
            writeSettings(context, action, jsonObj.payload.settings);
        }

        // apply settings when the action appears
        else if (event == "willAppear"){
            writeSettings(context, action, jsonObj.payload.settings);
        }

        // stop polling and delete settings when the action disappears
        else if (event == "willDisappear"){
            if ("poller" in instances[context]){
                clearInterval(instances[context].poller);
            }
            pihole_end(instances[context]);
            delete instances[context];
        }

        // handle a keypress
        else if (event == "keyUp"){
            if (!instances[context]) return;
            if (action == "us.johnholbrook.pihole.toggle"){
                toggle(context);
            }
            else if (action == "us.johnholbrook.pihole.temporarily-disable"){
                temporarily_disable(context);
            }
            else if (action == "us.johnholbrook.pihole.disable"){
                disable(context);
            }
            else if (action == "us.johnholbrook.pihole.enable"){
                enable(context);
            }
        }
    }
}
