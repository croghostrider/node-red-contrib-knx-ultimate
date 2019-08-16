const knx = require('knx')
const dptlib = require('knx/src/dptlib')
const oOS = require('os')

//Helpers
sortBy = (field) => (a, b) => {
    if (a[field] > b[field]) { return 1 } else { return -1 }
}


onlyDptKeys = (kv) => {
    return kv[0].startsWith("DPT")
}

extractBaseNo = (kv) => {
    return {
        subtypes: kv[1].subtypes,
        base: parseInt(kv[1].id.replace("DPT", ""))
    }
}

convertSubtype = (baseType) => (kv) => {
    let value = `${baseType.base}.${kv[0]}`
    return {
        value: value
        , text: value + ` (${kv[1].name})`
    }
}


toConcattedSubtypes = (acc, baseType) => {
    let subtypes =
        Object.entries(baseType.subtypes)
            .sort(sortBy(0))
            .map(convertSubtype(baseType))

    return acc.concat(subtypes)
}



module.exports = (RED) => {


    RED.httpAdmin.get("/knxUltimateDpts", RED.auth.needsPermission('knxUltimate-config.read'), function (req, res) {
        const dpts =
            Object.entries(dptlib)
                .filter(onlyDptKeys)
                .map(extractBaseNo)
                .sort(sortBy("base"))
                .reduce(toConcattedSubtypes, [])

        res.json(dpts)
    })

    function knxUltimateConfigNode(config) {
        RED.nodes.createNode(this, config)
        var node = this
        node.host = config.host
        node.port = config.port
        node.physAddr = config.physAddr || "15.15.22"; // the KNX physical address we'd like to use
        node.suppressACKRequest = typeof config.suppressACKRequest ==="undefined" ? false:config.suppressACKRequest; // enable this option to suppress the acknowledge flag with outgoing L_Data.req requests. LoxOne needs this
        node.csv = readCSV(config.csv); // Array from ETS CSV Group Addresses
        node.status = "disconnected";
        var knxErrorTimeout;
        node.nodeClients = [] // Stores the registered clients
        node.KNXEthInterface = typeof config.KNXEthInterface ==="undefined" ? "Auto" : config.KNXEthInterface;
        
        // Endpoint for reading csv from the other nodes
        RED.httpAdmin.get("/knxUltimatecsv", RED.auth.needsPermission('knxUltimate-config.read'), function (req, res) {
            res.json(node.csv)
        });
        // 14/08/2019 Endpoint for retrieving the ethernet interfaces
        RED.httpAdmin.get("/knxUltimateETHInterfaces", RED.auth.needsPermission('knxUltimate-config.read'), function (req, res) {
            var oiFaces = oOS.networkInterfaces();
            var jListInterfaces = [];
            try {
                Object.keys(oiFaces).forEach(ifname => {
                    // Interface wit single IP
                    if (Object.keys(oiFaces[ifname]).length === 1) {
                        if (Object.keys(oiFaces[ifname])[0].internal == false) jListInterfaces.push({ name: ifname, address:Object.keys(oiFaces[ifname])[0].address});
                    } else {
                        var sAddresses = "";
                        oiFaces[ifname].forEach(function (iface) {
                            if (iface.internal == false) sAddresses += "+" + iface.address;
                        });
                        if (sAddresses!=="") jListInterfaces.push({ name: ifname, address:sAddresses});
                    }
                })
            } catch (error) {}
            res.json(jListInterfaces)
        });
        
        node.addClient = (_Node) => {
            // Check if node already exists
            if (node.nodeClients.filter(x => x.id === _Node.id).length === 0) {
                // Check if the node has a valid topic and dpt
                if (_Node.listenallga==false) {
                    if (typeof _Node.topic == "undefined" || typeof _Node.dpt == "undefined") {
                        _Node.setNodeStatus({ fill: "red", shape: "dot", text: "Empty group address (topic) or datapoint." })
                        return;
                    } else {
            
                        // Topic must be in formar x/x/x
                        if (_Node.topic.split("\/").length < 3) {
                            _Node.setNodeStatus({ fill: "red", shape: "dot", text: "Wrong group address (topic: " + _Node.topic + ") format." })
                            return;
                        }
                    }
                }
                // Add _Node to the clients array
                node.nodeClients.push(_Node)
            }
            // At first node client connection, this node connects to the bus
            if (node.nodeClients.length === 1) {
                // 14/08/2018 Initialize the connection
                node.initKNXConnection();
            }
            if (_Node.initialread) {
                node.readValue(_Node.topic);
            }
        }

      
        node.removeClient = (_Node) => {
            // Remove the client node from the clients array
            //RED.log.info( "BEFORE Node " + _Node.id + " has been unsubscribed from receiving KNX messages. " + node.nodeClients.length);
            try {
                node.nodeClients = node.nodeClients.filter(x => x.id !== _Node.id)
            } catch (error) {}
            //RED.log.info("AFTER Node " + _Node.id + " has been unsubscribed from receiving KNX messages. " + node.nodeClients.length);

              // If no clien nodes, disconnect from bus.
            if (node.nodeClients.length === 0) {
                node.status = "disconnected";
                node.Disconnect();
            }
        }
      
        
        node.readInitialValues = () => {
            var readHistory = [];
            let delay = 0;
            node.nodeClients
                .filter(oClient => oClient.initialread)
                .forEach(oClient => {
                    if (oClient.listenallga==true) {
                        delay = delay + 200
                        for (let index = 0; index < node.csv.length; index++) {
                            const element = node.csv[index];
                            if (readHistory.includes(element.ga)) return
                            setTimeout(() => node.readValue(element.ga), delay)
                            readHistory.push(element.ga)
                        }
                    } else {
                        if (readHistory.includes(oClient.topic)) return
                        setTimeout(() => node.readValue(oClient.topic), delay)
                        delay = delay + 200
                        readHistory.push(oClient.topic)
                    }
                    
                })
        }
       
    
        node.readValue = topic => {
            if (node.knxConnection) {
                try {
                    node.knxConnection.read(topic)
                } catch (error) {
                    RED.log.error('knxUltimate readValue: (' + topic + ') ' + error);
                }
                
            }
        }
        
        node.setAllClientsStatus = (_status, _color, _text) => {
            function nextStatus(oClient) {
                oClient.setNodeStatus({ fill: _color, shape: "dot", text: "(" + oClient.topic + ") " + _status + " " + _text })
            }
            node.nodeClients.map(nextStatus);
        }
        
        node.initKNXConnection = () => {
            node.Disconnect();
            node.setAllClientsStatus("Waiting", "grey", "")
            if (node.KNXEthInterface !== "Auto")
            {
                RED.log.info("Start KNX Bus connection on interface : " + node.KNXEthInterface);
                node.knxConnection = new knx.Connection({
                    ipAddr: node.host,
                    ipPort: node.port,
                    physAddr: node.physAddr, // the KNX physical address we'd like to use
                    interface: node.KNXEthInterface,
                    suppress_ack_ldatareq: node.suppressACKRequest,
                    handlers: {
                        connected: () => {
                            node.status = "connected";
                            if (typeof knxErrorTimeout == "undefined") {
                                node.setAllClientsStatus("Connected", "green", "Waiting for telegram.")
                                node.readInitialValues() // Perform initial read if applicable
                            }
                        },
                        error: function (connstatus) {
                                node.status = "disconnected";
                                if (connstatus == "E_KNX_CONNECTION") {
                                    node.setAllClientsStatus("knxError", "yellow", "Error KNX BUS communication")
                                } else {
                                    node.setAllClientsStatus("Waiting", "grey", "")
                                }
                        }
                    }
                })
            } else {
                RED.log.info("Start KNX Bus connection on interface automatic selected.");
                node.knxConnection = new knx.Connection({
                    ipAddr: node.host,
                    ipPort: node.port,
                    physAddr: node.physAddr, // the KNX physical address we'd like to use
                    suppress_ack_ldatareq: node.suppressACKRequest,
                    handlers: {
                        connected: () => {
                            node.status = "connected";
                            if (typeof knxErrorTimeout == "undefined") {
                                node.setAllClientsStatus("Connected", "green", "Waiting for telegram.")
                                node.readInitialValues() // Perform initial read if applicable
                            }
                        },
                        error: function (connstatus) {
                                node.status = "disconnected";
                                if (connstatus == "E_KNX_CONNECTION") {
                                    node.setAllClientsStatus("knxError", "yellow", "Error KNX BUS communication")
                                } else {
                                    node.setAllClientsStatus("Waiting", "grey", "")
                                }
                        }
                    }
                }) 
            }

            node.knxConnection = new knx.Connection({
                ipAddr: node.host,
                ipPort: node.port,
                physAddr: node.physAddr, // the KNX physical address we'd like to use
                suppress_ack_ldatareq: node.suppressACKRequest,
                handlers: {
                    connected: () => {
                        node.status = "connected";
                        if (typeof knxErrorTimeout == "undefined") {
                            node.setAllClientsStatus("Connected", "green", "Waiting for telegram.")
                            node.readInitialValues() // Perform initial read if applicable
                        }
                    },
                    error: function (connstatus) {
                            node.status = "disconnected";
                            if (connstatus == "E_KNX_CONNECTION") {
                                node.setAllClientsStatus("knxError", "yellow", "Error KNX BUS communication")
                            } else {
                                node.setAllClientsStatus("Waiting", "grey", "")
                            }
                    }
                }
            })
            
            // Handle BUS events
            node.knxConnection.on("event", function (evt, src, dest, rawValue) {
                //if (dest == "0/1/8") RED.log.error("RX FROM BUS : " + src + " " + dest + " " + evt + rawValue);
                switch (evt) {
                    case "GroupValue_Write": {
                        node.nodeClients
                            .filter(input => input.notifywrite == true)
                            .forEach(input => {
                                if (input.listenallga == true) {
                                    // Get the GA from CVS
                                    let oGA = node.csv.filter(sga => sga.ga == dest)[0]
                                    let msg = buildInputMessage(src, dest, evt, rawValue, oGA.dpt, oGA.devicename)
                                    input.setNodeStatus({ fill: "green", shape: "dot", text: "(" + msg.knx.destination + ") " + msg.payload + " dpt:" + msg.knx.dpt });
                                    input.send(msg)
                                } else if (input.topic == dest) {
                                    let msg = buildInputMessage(src, dest, evt, rawValue, input.dpt, input.name ? input.name : "")
                                    // Check RBE INPUT from KNX Bus, to avoid send the payload to the flow, if it's equal to the current payload
                                    if (!checkRBEInputFromKNXBusAllowSend(input, msg.payload)) {
                                        input.setNodeStatus({fill: "grey", shape: "ring", text: "rbe block ("+msg.payload+") from KNX"})
                        return;
                    };
                                    input.currentPayload = msg.payload;// Set the current value for the RBE input
                                    input.setNodeStatus({fill: "green", shape: "dot", text: "(" + input.topic + ") " + msg.payload});
                                    //RED.log.error("RX FROM BUS : " + input.id +" " + src + " " + dest + " " + evt)
                                    input.send(msg)
                                }
                            })
                        break;
                    }
                    case "GroupValue_Response": {
                        
                        node.nodeClients
                            .filter(input => input.notifyresponse==true)
                            .forEach(input => {
                                if (input.listenallga==true) {
                                    // Get the DPT
                                    let oGA = node.csv.filter(sga => sga.ga == dest)[0]
                                    let msg = buildInputMessage(src, dest, evt, rawValue, oGA.dpt, oGA.devicename)
                                    input.setNodeStatus({ fill: "blue", shape: "dot", text: "(" + msg.knx.destination + ") " + msg.payload + " dpt:" + msg.knx.dpt });
                                    input.send(msg)
                                } else if (input.topic == dest) {
                                    let msg = buildInputMessage(src, dest, evt, rawValue, input.dpt, input.name ? input.name : "")
                                    // Check RBE INPUT from KNX Bus, to avoid send the payload to the flow, if it's equal to the current payload
                                    if (!checkRBEInputFromKNXBusAllowSend(input, msg.payload)) {
                                        input.setNodeStatus({ fill: "grey", shape: "ring", text: "rbe INPUT filter applied on " + msg.payload })
                                        return;
                                    };
                                    input.currentPayload = msg.payload; // Set the current value for the RBE input
                                    input.setNodeStatus({ fill: "blue", shape: "dot", text: "(" + input.topic + ") " + msg.payload });
                                    input.send(msg)
                                }
                            })
                        break;
                    }
                    case "GroupValue_Read": {
                        
                        node.nodeClients
                            .filter(input => input.notifyreadrequest==true)
                            .forEach(input => {
                                if (input.listenallga==true) {
                                    // Get the DPT
                                    let oGA = node.csv.filter(sga => sga.ga == dest)[0]
                                    let msg = buildInputMessage(src, dest, evt, null, oGA.dpt, oGA.devicename)
                                    input.setNodeStatus({ fill: "grey", shape: "dot", text: "(" + msg.knx.destination + ") read dpt:" + msg.knx.dpt });
                                    input.send(msg)
                                } else if (input.topic == dest) {
                                    let msg = buildInputMessage(src, dest, evt, null, input.dpt, input.name ? input.name :"")
                                    input.setNodeStatus({ fill: "grey", shape: "dot", text: "(" + input.topic + ") read" });
                                    input.send(msg)
                                }
                            })
                        break;
                    }
                    default: return
                }
            })
        }

        node.Disconnect = () => {
            node.setAllClientsStatus("Waiting", "grey", "")
            // Remove listener
            try {
                node.knxConnection.removeListener("event");    
            } catch (error) {
                
            }
            try {
                node.knxConnection.off("event");
            } catch (error) {
                
            }
            node.knxConnection = null;
        }

        // 14/08/2019 If the node has payload same as the received telegram, return false
        checkRBEInputFromKNXBusAllowSend = (_node, _KNXTelegramPayload) => {
            if (_node.inputRBE !== true) return true;
            if (typeof _node.currentPayload === "undefined") return true;
            var curVal = _node.currentPayload.toString().toLowerCase();
            var newVal = _KNXTelegramPayload.toString().toLowerCase();
            if (curVal==="false") {
                curVal = "0";
            }
            if (curVal==="true") {
                curVal = "1";
            }
            if (newVal==="false") {
                newVal = "0";
            }
            if (newVal==="true") {
                newVal = "1";
            }
            if (curVal === newVal) {
                 return false;
            }
            return true;
        }
        


        function buildInputMessage(src, dest, evt, value, inputDpt, _devicename) {
            // Resolve DPT and convert value if available
            var dpt = dptlib.resolve(inputDpt)
            var jsValue = null
            if (dpt && value) {
                var jsValue = dptlib.fromBuffer(value, dpt)
            }

            // Build final input message object
            return {
                topic: dest
                , payload: jsValue
                , knx:
                {
                    event: evt
                    , dpt: inputDpt
                    //, dptDetails: dpt
                    , source: src
                    , destination: dest
                    , rawValue: value
                }
                , devicename: (typeof _devicename !== 'undefined') ? _devicename : ""
            }
        }
    

        node.on("close", function () {
            node.Disconnect();
        })
 
        function readCSV(_csvText) {
                
            var ajsonOutput = new Array(); // Array: qui va l'output totale con i nodi per node-red
           
            if (_csvText == "") {
                RED.log.info('knxUltimate: no csv ETS found');
                return;
            } else {
                RED.log.info('knxUltimate: csv ETS found !');
                // Read and decode the CSV in an Array containing:  "group address", "DPT", "Device Name"
                let fileGA = _csvText.split("\n");
                // Controllo se le righe dei gruppi contengono il separatore di tabulazione
                if (fileGA[0].search("\t") == -1) {
                    RED.log.error('knxUltimate: ERROR: the csv ETS file must have the tabulation as separator')
                    return;
                }
    
                var sFirstGroupName = "";
                var sSecondGroupName = "";
                var sFather="";
                for (let index = 0; index < fileGA.length; index++) {
                    const element = fileGA[index].replace(/\"/g, ""); // Rimuovo le virgolette
                    if (element !== "") {
                        
                        // Main and secondary group names
                        if ((element.split("\t")[1].match(/-/g) || []).length == 2) {
                            // Found main group family name (Example Light Actuators)
                            sFirstGroupName = element.split("\t")[0] || "";
                            sSecondGroupName = "";
                        }
                        if ((element.split("\t")[1].match(/-/g)||[]).length==1) {
                            // Found second group family name (Example First Floor light)
                            sSecondGroupName = element.split("\t")[0] || "";
                        }
                        if(sFirstGroupName!=="" && sSecondGroupName !==""){sFather="(" + sFirstGroupName + "->" +sSecondGroupName + ") " }
                       
                        if (element.split("\t")[1].search("-") == -1 && element.split("\t")[1].search("/") !== -1) {
                            // Ho trovato una riga contenente un GA valido, cioè con 2 "/"
                            if (element.split("\t")[5] == "") {
                                RED.log.error("knxUltimate: ERROR: Datapoint not set in ETS CSV. Please set the datapoint with ETS and export the group addresses again. ->" + element.split("\t")[0] + " " + element.split("\t")[1])
                                return;
                            }
                            var DPTa = element.split("\t")[5].split("-")[1];
                            var DPTb = element.split("\t")[5].split("-")[2];
                            if (typeof DPTb == "undefined") {
                                RED.log.warn("knxUltimate: WARNING: Datapoint not fully set (there is only the first part on the left of the '.'). I applied a default .001, but please set the datapoint with ETS and export the group addresses again. ->" + element.split("\t")[0] + " " + element.split("\t")[1] + " Datapoint: " + element.split("\t")[5] );
                                DPTb = "001"; // default
                            }
                            // Trailing zeroes
                            if (DPTb.length == 1) {
                                DPTb = "00" + DPTb;
                            } else if (DPTb.length == 2) {
                                DPTb = "0" + DPTb;
                            } if (DPTb.length == 3) {
                                DPTb = "" + DPTb; // stupid, but for readability
                            }
                            ajsonOutput.push({ga:element.split("\t")[1], dpt:DPTa + "." + DPTb, devicename: sFather + element.split("\t")[0]});
                        }
                    }
                }
                
                return ajsonOutput;
            }
    
        }
    
    }

   

    RED.nodes.registerType("knxUltimate-config", knxUltimateConfigNode);
}


