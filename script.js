// =========================================================
// BBU ARCHITECT SIMULATOR - SCRIPT.JS (Parte 1/5)
// =========================================================

// --- 1. CONFIGURAÇÕES GERAIS E ESTADO GLOBAL ---

// Definição global para acesso em todo o script
var cableManager;

var availableBoards = [];
// --- PLACAS DE CONTROLE (UMPT) ---
availableBoards.push({ model: "UMPTe (Control)", type: "UMPT" });
availableBoards.push({ model: "UMPTg2 (Control)", type: "UMPT" });

// --- PLACAS DE ENERGIA (UPEU) ---
availableBoards.push({ model: "UPEUc (360W)", type: "UPEU" });
availableBoards.push({ model: "UPEUd (650W)", type: "UPEU" });
availableBoards.push({ model: "UPEUe (1100W)", type: "UPEU" });

// --- PLACAS DE PROCESSAMENTO (UBBP) ---
// rawBoardList vem do arquivo data.js
if (typeof rawBoardList !== 'undefined') {
    var items = rawBoardList.split(';');
    items.forEach(function(item) { 
        item = item.trim(); 
        if(item) availableBoards.push({ model: item, type: "UBBP" }); 
    });
}

// --- FUNÇÕES AUXILIARES DE SPECS ---

function getBoardSpecs(modelName) {
    if (!modelName) return null;
    var cleanName = modelName.split('(')[0].trim(); 
    // BOARD_SPECS_TN vem do arquivo data.js
    if(typeof BOARD_SPECS_TN !== 'undefined' && BOARD_SPECS_TN[cleanName]) {
        return BOARD_SPECS_TN[cleanName];
    }
    return null; 
}

function getUpeuSpecs(modelName) {
    // UPEU_SPECS vem do arquivo data.js
    if(typeof UPEU_SPECS === 'undefined') return { capacity: 1100, price: "R$ 2.800,00" }; // Fallback de segurança
    
    if(!modelName) return UPEU_SPECS["UPEUe"];
    if(modelName.includes("UPEUc")) return UPEU_SPECS["UPEUc"];
    if(modelName.includes("UPEUd")) return UPEU_SPECS["UPEUd"];
    if(modelName.includes("UPEUe")) return UPEU_SPECS["UPEUe"];
    return UPEU_SPECS["UPEUe"]; 
}

// Variáveis de Estado Global (Hardware)
var siteNames = { local: "Local", remote: "Remote" };

var dcduSwitches = { 18: false, 19: false };
var umptStates = { 6: 'OFF', 7: 'OFF' };
var bootTimers = { 6: null, 7: null };
var activeFaults = {};
var siteStackLevel = 0;

// --- ESTADO DE TRANSMISSÃO ---
var transmissionState = {
    ip: "0.0.0.0",
    mask: "0.0.0.0",
    gateway: "0.0.0.0",
    isConfigured: false
};

// Estado de Drag & Drop de Hardware
var isDraggingBoard = false;
var draggedBoardData = null;
var draggedBoardGhost = null;
var draggedFromSlot = null;

// Ferramentas Globais
var tempCableForPolarity = null;
var polyDragState = { active: false, wireColor: null, startX: 0, startY: 0, tempLine: null };
var polyConnections = [];
var remoteSiteCounter = 0;
var pendingConfirmAction = null;
var ueInterval = null;
var towerState = { active: false, hasBracket: false, hasRRU: false, isGrounded: false, cableConnected: false, isWeatherproofed: false };

// =========================================================
// --- 2. CLASSE CABLE MANAGER (Lógica de Cabos) ---
// =========================================================
class CableManager {
    constructor() {
        this.cables = [];
        this.activeCableId = null; 
        
        // ESTADOS
        this.isDrawing = false;           
        this.isDraggingVertex = false;    
        this.isDraggingCon = false;       
        
        this.draggedVertexInfo = null;    
        this.hoveredCableId = null;
        this.jumperDragMode = null;
        
        // Drag de Peças Soltas
        this.isDraggingSFP = false; this.draggedSFPElement = null;
        this.isDraggingDummy = false; this.draggedDummyElement = null;
        this.isDraggingUSB = false; this.draggedUSBElement = null;

        this.container = document.getElementById('simContainer');
        this.svgLayer = document.getElementById('cableLayer');
        
        this.ghostVertex = null; // Bolinha verde de previsão

        this.setupEvents();
    }

    setupEvents() {
        // Eventos de Mouse
        this.container.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.container.addEventListener('mousedown', (e) => this.handleMouseDown(e)); 
        this.container.addEventListener('mouseup', (e) => this.handleMouseUp(e));
        
        // Listener para Teclado (Ctrl e Esc)
        window.addEventListener('keydown', (e) => { 
            if(e.key === 'Control') this.updateCursorState(e, true); 
            if (e.key === 'Escape') this.cancelDrawing();
        });

        window.addEventListener('keyup', (e) => { 
            if(e.key === 'Control') this.updateCursorState(e, false); 
        });
    }

    cancelDrawing() {
        // 1. Cancela desenho de cabo novo
        if (this.isDrawing && this.activeCableId) {
            this.cables = this.cables.filter(c => c.id !== this.activeCableId);
            this.isDrawing = false;
            this.activeCableId = null;
            this.render(); 
            showNotification("Criação de cabo cancelada.", "warning");
        }
        
        // 2. Cancela arraste de componentes
        if (this.isDraggingSFP && this.draggedSFPElement) {
            this.isDraggingSFP = false;
            this.draggedSFPElement.remove();
            this.draggedSFPElement = null;
            this.clearHighlights();
        }
        if (this.isDraggingDummy && this.draggedDummyElement) {
            this.isDraggingDummy = false;
            this.draggedDummyElement.remove();
        }
    }

    updateCursorState(e, isCtrl) {
        if (isCtrl) {
            if(this.ghostVertex && this.ghostVertex.style.display === 'block') {
                this.container.style.cursor = "cell";
            }
        } else {
            this.container.style.cursor = "default";
        }
    }

    // --- CRIAÇÃO DE CABOS (SPAWN) ---
    
    spawnCableGeneric(sourceType, sourceIndex, startX, startY, color, boxId) {
        var id = 'cabo_' + Date.now();
        var originLabel = sourceType;
        
        if (sourceType === 'LOCAL') originLabel = siteNames.local;
        else if (sourceType === 'REMOTE') {
            if (boxId === 'oduRemote') originLabel = siteNames.remote;
            else {
                var el = document.getElementById(boxId);
                originLabel = el ? el.querySelector('.site-name-display').innerText : "Site";
            }
        }

        // Offset para não sobrepor cabos na saída
        var existingCount = this.cables.filter(c => (c.boxId === boxId) || (c.sourceType === sourceType)).length;
        var offset = existingCount * 8; 

        var isSide = (sourceType === 'LOCAL' || sourceType === 'REMOTE');
        var adjustedStartX = startX;
        var adjustedStartY = startY;

        if (isSide) adjustedStartY += offset - 10; 
        else adjustedStartX += offset - 10;        

        var pStart = { x: adjustedStartX, y: adjustedStartY, type: 'start' };
        var pMouse = { x: adjustedStartX + 20, y: adjustedStartY + 20, type: 'end' }; 

        this.cables.push({ 
            id: id, sourceType: sourceType, sourceIndex: sourceIndex, siteOrigin: originLabel, boxId: boxId, color: color,
            points: [pStart, pMouse], 
            config: { sector: null, radio: null }, connectedTo: null, polarityStatus: null 
        });
        
        this.isDrawing = true;
        this.activeCableId = id;
        
        if(typeof atualizarContadoresGeral === 'function') atualizarContadoresGeral(); 
        this.render();
        showNotification("Modo Desenho: Clique no vazio para fazer curvas (90°). Clique na porta para conectar.", "success");
    }

    spawnJumperCable() { 
        var boxRect = document.getElementById('partsBox').getBoundingClientRect();
        var cR = this.container.getBoundingClientRect();
        var sX = (boxRect.right - cR.left) + 20; 
        var sY = (boxRect.top - cR.top) + 50;
        
        this.cables.push({ 
            id: 'jump_' + Date.now(), 
            sourceType: 'JUMPER', 
            color: '#7d7b79', 
            points: [{x:sX, y:sY, type:'start'}, {x:sX+100, y:sY, type:'end'}],
            connectedToStart: null, 
            connectedTo: null 
        });
        this.render(); 
    }

    spawnODUCable(type, boxId) { 
        var count = this.cables.filter(c => c.boxId === boxId).length;
        if(count >= 6) return showNotification("Limite de 6 cabos!", "warning"); 
        var bR = document.getElementById(boxId).getBoundingClientRect(); 
        var cR = this.container.getBoundingClientRect(); 
        this.spawnCableGeneric(type, 0, (bR.right - cR.left), (bR.top - cR.top) + (bR.height / 2), 'null', boxId);
    }

    spawnUMPTCable() { 
        var bR = document.getElementById('umptBox').getBoundingClientRect(); 
        var cR = this.container.getBoundingClientRect(); 
        this.spawnCableGeneric('UMPT', 0, (bR.left - cR.left) + (bR.width/2), (bR.top - cR.top), '#f37021'); 
    }

    spawnDCDUCable() { 
        var bR = document.getElementById('dcduBox').getBoundingClientRect(); 
        var cR = this.container.getBoundingClientRect(); 
        this.spawnCableGeneric('ENERGY', 0, (bR.left - cR.left) + (bR.width/2), (bR.top - cR.top), '#e74c3c'); 
    }

    spawnGPSCable() { 
        var bR = document.getElementById('gpsBox').getBoundingClientRect(); 
        var cR = this.container.getBoundingClientRect(); 
        this.spawnCableGeneric('GPS', 0, (bR.left - cR.left) + (bR.width/2), (bR.top - cR.top), '#ffea03'); 
    }

    // Spawns de Peças Menores
    spawnSFP(e) { 
        e.preventDefault(); 
        e.stopPropagation();
        this.isDraggingSFP = true;
        this.draggedSFPElement = this.createDragEl('draggable-sfp', e); 
    }
    
    spawnDummy(e) { 
        e.preventDefault(); 
        this.isDraggingDummy = true; 
        this.draggedDummyElement = this.createDragEl('draggable-dummy', e); 
    }
    
    spawnUSB(e) { 
        e.preventDefault(); 
        this.isDraggingUSB = true; 
        this.draggedUSBElement = this.createDragEl('draggable-usb', e); 
    }

    createDragEl(cl, e) { 
        var el = document.createElement('div'); 
        el.className = cl; 
        var cR = this.container.getBoundingClientRect(); 
        el.style.left = (e.clientX - cR.left) + 'px'; 
        el.style.top = (e.clientY - cR.top) + 'px'; 
        this.container.appendChild(el); 
        return el; 
    }
    // =========================================================
// BBU ARCHITECT SIMULATOR - SCRIPT.JS (Parte 2/5)
// =========================================================

    // --- RENDERIZAÇÃO VISUAL (SVG) ---
    render() {
        this.svgLayer.innerHTML = '';
        this.cables.forEach((c) => {
            // Estilo e Cores
            var isJumper = (c.sourceType === 'JUMPER');
            var isSideBox = (c.sourceType === 'LOCAL' || c.sourceType === 'REMOTE');
            
            // SECTOR_COLORS vem do data.js
            var color = isJumper ? '#7d7b79' : (isSideBox ? (SECTOR_COLORS[c.config.sector] || SECTOR_COLORS['null']) : c.color);
            var opacity = (c.id === this.activeCableId) ? 1.0 : 0.9;
            
            // 1. CÁLCULO DO TRAÇADO (PATH)
            var d = `M ${c.points[0].x} ${c.points[0].y}`;
            
            // Lógica da Curva Automática (Jumper)
            if (isJumper && c.points.length === 2) {
                var p1 = c.points[0];
                var p2 = c.points[1];

                var midX = (p1.x + p2.x) / 2;
                
                // Ajuste da curvatura (20px base + 10% da distância)
                var midY = Math.max(p1.y, p2.y) + 20; 
                var dist = Math.abs(p2.x - p1.x);
                if (dist > 50) midY += (dist * 0.1);

                d += ` Q ${midX} ${midY} ${p2.x} ${p2.y}`;

            } else {
                // Lógica Padrão (Linhas Retas)
                for(var i = 1; i < c.points.length; i++) {
                    d += ` L ${c.points[i].x} ${c.points[i].y}`;
                }
            }

            // 2. DESENHO VISUAL (O cabo fino colorido)
            var path = document.createElementNS("http://www.w3.org/2000/svg", "path"); 
            path.setAttribute("d", d); 
            path.setAttribute("stroke", color); 
            path.setAttribute("stroke-width", (c.id === this.activeCableId) ? 5 : 3); 
            path.setAttribute("fill", "none"); 
            path.setAttribute("stroke-linejoin", "round");
            path.setAttribute("stroke-linecap", "round");
            path.setAttribute("style", "pointer-events:none; opacity:" + opacity); 
            this.svgLayer.appendChild(path);

            // 3. ÁREA DE CLIQUE (HIT AREA)
            if (!this.isDrawing) {
                // Área de clique curva para Jumpers
                if (isJumper && c.points.length === 2) {
                    var hitPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
                    hitPath.setAttribute("d", d); 
                    hitPath.setAttribute("stroke", "transparent"); 
                    hitPath.setAttribute("stroke-width", 20); 
                    hitPath.setAttribute("fill", "none");
                    hitPath.setAttribute("style", "cursor: pointer; pointer-events: stroke;");
                    
                    hitPath.onmouseenter = () => { this.hoveredCableId = c.id; this.render(); };
                    hitPath.onmouseout = () => { 
                        setTimeout(() => { if(this.hoveredCableId === c.id) { this.hoveredCableId = null; this.render(); } }, 50);
                    };
                    hitPath.onmousedown = (e) => {
                        try {
                            e.preventDefault(); 
                            e.stopPropagation();
                            console.log("Clique em cabo detectado: " + c.id);
                            abrirConfigCabo(c.id);
                        } catch (err) {
                            console.error("Erro ao abrir config de cabo (path):", err);
                            showNotification("Erro ao configurar cabo", "error");
                        }
                    };
                    this.svgLayer.appendChild(hitPath);
                } else {
                    // Cabos normais (segmentados)
                    for(var i = 0; i < c.points.length - 1; i++) {
                        this.createHitSegment(c, i, c.points[i], c.points[i+1]);
                    }
                }
            }

            // 4. BOLINHAS NAS PONTAS (HANDLES)
            var showHandles = (c.id === this.hoveredCableId);
            
            c.points.forEach((p, idx) => {
                if (isJumper) {
                    // Jumper: Sempre mostra as pontas
                    if (p.type === 'start' || p.type === 'end') {
                        this.createCableHead(c, p.x, p.y, color, p.type);
                    }
                } 
                else {
                    // Cabo Normal
                    if (p.type === 'start') {
                         if (showHandles) this.createCableHead(c, p.x, p.y, color, 'start');
                    } else if (p.type === 'end') {
                         this.createCableHead(c, p.x, p.y, color, 'end');
                    } else {
                         if (showHandles) this.createVertexHandle(c, idx, p.x, p.y, color);
                    }
                }
            });
        });
        
        if(typeof atualizarPowerBudget === 'function') atualizarPowerBudget();
    }

    // --- INTERAÇÃO COM SEGMENTOS ---
    createHitSegment(cable, index, p1, p2) {
        var hitLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
        hitLine.setAttribute("x1", p1.x); hitLine.setAttribute("y1", p1.y);
        hitLine.setAttribute("x2", p2.x); hitLine.setAttribute("y2", p2.y);
        hitLine.setAttribute("stroke", "transparent");
        hitLine.setAttribute("stroke-width", 15); 
        hitLine.setAttribute("style", "cursor: pointer; pointer-events:stroke;");
        
        hitLine.onmouseenter = (e) => {
            this.hoveredCableId = cable.id;
            this.render(); 
        };
        
        hitLine.onmousemove = (e) => {
            if (e.ctrlKey) {
                this.container.style.cursor = "cell"; 
                this.showGhostVertex(e);
            } else {
                this.container.style.cursor = "pointer";
                this.hideGhostVertex();
            }
        };
        
        hitLine.onmouseout = (e) => {
            setTimeout(() => {
                if(this.hoveredCableId === cable.id && !this.container.querySelector(':hover')) {
                    this.hoveredCableId = null;
                    this.render();
                }
            }, 50);
            this.hideGhostVertex();
        };

        hitLine.onmousedown = (e) => {
            try {
                e.preventDefault(); 
                e.stopPropagation();
                if (e.ctrlKey) {
                    console.log("Ctrl+Clique: adicionando vértice");
                    this.splitSegment(cable.id, index, e.clientX, e.clientY);
                } else {
                    console.log("Clique em cabo detectado: " + cable.id);
                    abrirConfigCabo(cable.id);
                }
            } catch (err) {
                console.error("Erro ao processar clique em cabo (segment):", err);
                showNotification("Erro ao configurar cabo", "error");
            }
        };

        this.svgLayer.appendChild(hitLine);
    }

    showGhostVertex(e) {
        if (!this.ghostVertex) {
            this.ghostVertex = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            this.ghostVertex.setAttribute("r", 5);
            this.ghostVertex.setAttribute("fill", "#2ecc71");
            this.ghostVertex.setAttribute("stroke", "#fff");
            this.ghostVertex.setAttribute("pointer-events", "none");
            this.svgLayer.appendChild(this.ghostVertex);
        }
        var cR = this.container.getBoundingClientRect();
        this.ghostVertex.setAttribute("cx", e.clientX - cR.left);
        this.ghostVertex.setAttribute("cy", e.clientY - cR.top);
        this.ghostVertex.style.display = "block";
    }
    hideGhostVertex() { if (this.ghostVertex) this.ghostVertex.style.display = "none"; }

    splitSegment(cId, idx, cx, cy) {
        var cR = this.container.getBoundingClientRect();
        var cable = this.cables.find(c => c.id === cId);
        if(cable) {
            var mX = cx - cR.left;
            var mY = cy - cR.top;
            var prev = cable.points[idx];
            var next = cable.points[idx+1];
            
            var snapDist = 30; 
            if(prev) { if(Math.abs(mX - prev.x)<snapDist) mX=prev.x; if(Math.abs(mY - prev.y)<snapDist) mY=prev.y; }
            if(next) { if(Math.abs(mX - next.x)<snapDist) mX=next.x; if(Math.abs(mY - next.y)<snapDist) mY=next.y; }

            var newPt = { x: mX, y: mY, type: 'vertex' };
            cable.points.splice(idx + 1, 0, newPt);
            
            this.isDraggingVertex = true;
            this.draggedVertexInfo = { cableId: cId, index: idx + 1 };
            this.render();
        }
    }

    // --- MANIPULADORES DE EVENTOS DE MOUSE ---

    handleMouseDown(e) {
        var cRect = this.container.getBoundingClientRect();
        var mX = e.clientX - cRect.left; 
        var mY = e.clientY - cRect.top;

        // MODO DESENHO (CRIAR VÉRTICE)
        if (this.isDrawing && this.activeCableId) {
            e.stopPropagation(); 
            var cable = this.cables.find(c => c.id === this.activeCableId);
            
            // 1. TENTA CONECTAR NA PORTA
            var port = this.getHoveredPort(mX, mY);
            if (port) {
                this.finalizeConnection(cable, port);
                return; 
            } 

            // 2. CLIQUE NO VAZIO -> CRIA VÉRTICE (QUINA 90°)
            var movingTip = cable.points[cable.points.length - 1];
            var newVertex = { x: movingTip.x, y: movingTip.y, type: 'vertex' };
            cable.points.splice(cable.points.length - 1, 0, newVertex);
            
            this.render();
            return;
        }
    }

    handleMouseMove(e) {
        var cRect = this.container.getBoundingClientRect();
        var mX = e.clientX - cRect.left;
        var mY = e.clientY - cRect.top;

        // 1. DRAG DE COMPONENTES (SFP, DUMMY, USB)
        if (this.isDraggingSFP && this.draggedSFPElement) {
             this.draggedSFPElement.style.left = (mX - 10) + 'px';
             this.draggedSFPElement.style.top = (mY - 6) + 'px';
             this.checkProximity(mX, mY); 
             return;
        }
        if (this.isDraggingDummy && this.draggedDummyElement) {
            this.draggedDummyElement.style.left = (mX-30)+'px';
            this.draggedDummyElement.style.top = (mY-20)+'px'; return;
        }
        if (this.isDraggingUSB && this.draggedUSBElement) {
            this.draggedUSBElement.style.left = (mX-7)+'px';
            this.draggedUSBElement.style.top = (mY-12)+'px'; return;
        }

        // 2. MODO DESENHO (ORTOGONAL / 90 GRAUS)
        if (this.isDrawing && this.activeCableId) {
            var cable = this.cables.find(c => c.id === this.activeCableId);
            if (cable) {
                var lastPt = cable.points[cable.points.length - 1]; 
                var prevPt = cable.points[cable.points.length - 2]; 

                var diffX = Math.abs(mX - prevPt.x);
                var diffY = Math.abs(mY - prevPt.y);

                if (diffX > diffY) {
                    lastPt.x = mX;
                    lastPt.y = prevPt.y; 
                } else {
                    lastPt.x = prevPt.x; 
                    lastPt.y = mY;
                }

                this.checkProximity(mX, mY); 
                this.render();
            }
            return;
        }

        // 3. ARRASTAR VÉRTICES EXISTENTES
        if (this.isDraggingVertex && this.draggedVertexInfo) {
             var info = this.draggedVertexInfo;
             var cable = this.cables.find(c => c.id === info.cableId);
             if (cable) {
                 cable.points[info.index].x = mX;
                 cable.points[info.index].y = mY;
                 this.render();
             }
             return;
        }
        
        // 4. ARRASTAR PONTA
        if (this.isDraggingCon && this.activeCableId) {
             var cable = this.cables.find(c => c.id === this.activeCableId);
             if(cable) {
                 var pt = (this.jumperDragMode === 'start') ? cable.points[0] : cable.points[cable.points.length-1];
                 pt.x = mX; pt.y = mY;
                 this.checkProximity(mX, mY);
                 this.render();
             }
        }
    }

    handleMouseUp(e) {
        // 1. SOLTAR SFP
        if (this.isDraggingSFP) {
            this.isDraggingSFP = false;
            var cRect = this.container.getBoundingClientRect();
            var dropX = e.clientX - cRect.left;
            var dropY = e.clientY - cRect.top;

            if (this.draggedSFPElement) {
                this.draggedSFPElement.remove();
                this.draggedSFPElement = null;
            }

            var p = this.getHoveredPort(dropX, dropY);
            var forbiddenPorts = ['18', '19', 'GPS', 'PWR', 'MON0', 'MON1'];
            if (p) {
                if (!forbiddenPorts.includes(p.pid) && !p.pid.includes('PWR')) {
                    p.element.classList.add('has-sfp');
                    p.element.setAttribute('data-has-sfp', 'true');
                    showNotification("SFP Instalado com sucesso!", "success");
                } else {
                    showNotification("Esta porta não aceita SFP.", "warning");
                }
            }
            this.clearHighlights();
            return;
        }

        // 2. SOLTAR OUTROS ITENS
        if (this.isDraggingDummy) {
            this.isDraggingDummy = false;
            if(this.draggedDummyElement) this.draggedDummyElement.remove();
            return;
        } 
        if (this.isDraggingUSB) {
            this.isDraggingUSB = false;
            if(this.draggedUSBElement) this.draggedUSBElement.remove();
            return;
        }

        // 3. SOLTAR VÉRTICE
        if (this.isDraggingVertex) {
            this.isDraggingVertex = false;
            this.draggedVertexInfo = null;
            this.render();
            return;
        }

        // 4. SOLTAR CONECTOR DE CABO
        if (this.isDraggingCon) {
            this.isDraggingCon = false;
            var cable = this.cables.find(c => c.id === this.activeCableId);
            if (cable) {
                var isStart = (cable.sourceType === 'JUMPER' && this.jumperDragMode === 'start');
                var pt = isStart ? cable.points[0] : cable.points[cable.points.length - 1];
                
                var port = this.getHoveredPort(pt.x, pt.y);
                
                if (port) {
                    // Validação Jumper
                    var pid = port.pid;
                    var isDataPort = (port.element.classList.contains('sfp-cage') || pid.includes('HEI') || pid.includes('XGE') || pid.includes('GE') || !isNaN(parseInt(pid)));
                    
                    if (cable.sourceType === 'JUMPER' && !isDataPort) {
                        showNotification("Jumpers só conectam em portas de dados!", "error");
                        if (isStart) cable.connectedToStart = null;
                        else cable.connectedTo = null;
                    } else {
                        // Conexão Válida
                        var pRect = port.element.getBoundingClientRect();
                        var cRect = this.container.getBoundingClientRect();
                        pt.x = (pRect.left - cRect.left) + (pRect.width / 2);
                        pt.y = (pRect.top - cRect.top) + (pRect.height / 2);
                        
                        var connectionString = "Slot " + port.slot + " Port " + port.pid;
                        if (isStart) cable.connectedToStart = connectionString;
                        else cable.connectedTo = connectionString;
                        
                        if(cable.sourceType === 'JUMPER') showNotification("Jumper Conectado!", "success");
                    }

                } else {
                    if (isStart) cable.connectedToStart = null;
                    else cable.connectedTo = null;
                }
                
                if(typeof validarCapacidadeBBU === 'function') validarCapacidadeBBU(); 
                this.render();
            }
            this.activeCableId = null;
        }
        
        if (this.isDrawing) return;
    }
    // =========================================================
// BBU ARCHITECT SIMULATOR - SCRIPT.JS (Parte 3/5)
// =========================================================

    finalizeConnection(cable, port) {
        var slotId = parseInt(port.slot);
        var pid = port.pid;
        var hasSfpInstalled = port.element.classList.contains('has-sfp') || port.element.getAttribute('data-has-sfp') === 'true';
        var allowed = false;
        var errorMsg = "";

        // Regras de Conexão
        if (cable.sourceType === 'LOCAL' || cable.sourceType === 'REMOTE' || cable.sourceType === 'UMPT') {
             var isFiberPort = (port.element.classList.contains('sfp-cage') || pid.includes('XGE') || pid.includes('GE') || !isNaN(parseInt(pid)));
             if (isFiberPort) {
                 if (hasSfpInstalled) allowed = true;
                 else errorMsg = "Instale SFP primeiro.";
             } else errorMsg = "Porta incompatível.";
        }
        else if (cable.sourceType === 'GPS' && pid === 'GPS') allowed = true;
        else if (cable.sourceType === 'ENERGY' && pid === 'PWR') allowed = true;
        else if (cable.sourceType === 'JUMPER') allowed = true;
        
        if (!allowed) {
            showNotification("ERRO: " + (errorMsg || "Conexão inválida"), "error");
            return false;
        }

        // --- ALINHAMENTO AUTOMÁTICO (SNAP 90°) ---
        
        var pRect = port.element.getBoundingClientRect();
        var cRect = this.container.getBoundingClientRect();
        var targetX = (pRect.left - cRect.left) + (pRect.width / 2);
        var targetY = (pRect.top - cRect.top) + (pRect.height / 2);

        // Ajusta penúltimo vértice para manter ângulo reto
        var lastVertex = cable.points[cable.points.length - 2];
        var mouseTip = cable.points[cable.points.length - 1];

        mouseTip.x = targetX;
        mouseTip.y = targetY;

        if (Math.abs(lastVertex.x - targetX) < Math.abs(lastVertex.y - targetY)) {
            lastVertex.x = targetX; 
        } else {
            lastVertex.y = targetY;
        }

        // Finaliza
        cable.connectedTo = "Slot " + port.slot + " Port " + port.pid;
        this.isDrawing = false;
        this.activeCableId = null;

        if(cable.sourceType === 'ENERGY') {
            if(typeof openPolarityModal === 'function') openPolarityModal(cable);
        }
        
        this.render();
        showNotification("Conectado (Alinhado 90°)", "success");
        try {
            // Abre painel de config APENAS para cabos RF (LOCAL e REMOTE), não para UMPT, GPS ou DCDU
            if (cable && (cable.sourceType === 'LOCAL' || cable.sourceType === 'REMOTE')) {
                abrirPainelConfig(cable.id);
            }
        } catch (e) { console.warn('abrirPainelConfig falhou:', e); }
        return true;
    }

    // --- CRIAÇÃO DE MANIPULADORES VISUAIS ---

    createVertexHandle(c, index, x, y, color) {
        var handle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        handle.setAttribute("cx", x); 
        handle.setAttribute("cy", y);
        handle.setAttribute("r", 4);
        handle.setAttribute("fill", "#fff"); 
        handle.setAttribute("stroke", "#555");
        handle.setAttribute("style", "cursor: crosshair; pointer-events: all;");

        handle.onmousedown = (e) => {
            e.preventDefault(); 
            e.stopPropagation();

            // ALT + Click: Deletar Vértice
            if (e.altKey) { 
                c.points.splice(index, 1); 
                this.render(); 
                showNotification("Vértice removido.", "success");
                return; 
            } 
            
            // CTRL + Drag: Mover Vértice
            if (e.ctrlKey) {
                this.isDraggingVertex = true;
                this.draggedVertexInfo = { cableId: c.id, index: index };
            } else {
                showNotification("Segure CTRL para mover este vértice (ou ALT para deletar).", "warning");
            }
        };
        
        this.svgLayer.appendChild(handle);
    }

    createCableHead(c, x, y, color, type) {
        var circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", x); 
        circle.setAttribute("cy", y); 
        circle.setAttribute("r", 5);
        circle.setAttribute("fill", "#fff"); 
        circle.setAttribute("stroke", color); 
        circle.setAttribute("stroke-width", 2);

        if (this.isDrawing && c.id === this.activeCableId && type === 'end') {
            circle.setAttribute("style", "pointer-events: none;"); 
        } else {
            circle.setAttribute("style", "cursor: grab; pointer-events: all;");
            
            circle.onmousedown = (e) => {
                e.preventDefault(); 
                e.stopPropagation();
                
                // Lógica de segurança (Arco Voltaico ao desconectar energia ligada)
                if(c.sourceType === 'ENERGY' && c.connectedTo && type === 'end') { 
                    var slotId = c.connectedTo.includes('18') ? 18 : (c.connectedTo.includes('19') ? 19 : null);
                    if(slotId && dcduSwitches[slotId] === true) { 
                        if(typeof burnSlot === 'function') burnSlot(slotId); 
                        return; 
                    } 
                }

                this.isDraggingCon = true;
                this.activeCableId = c.id;
                this.jumperDragMode = type;
                this.isDrawing = false; 
                document.getElementById('cableConfigModal').style.display = 'none';
            };
        }
        
        this.svgLayer.appendChild(circle);
    }

    // --- UTILITÁRIOS DE MOUSE E ESTADO ---

    checkProximity(x, y) { 
        this.clearHighlights(); 
        var p = this.getHoveredPort(x, y); 
        if (p) p.element.classList.add('highlight'); 
    }
    
    clearHighlights() { 
        document.querySelectorAll('.bbu-port, .port-gps, .port-gps-sma, .port-power-in').forEach(p => p.classList.remove('highlight')); 
    }
    
    getHoveredPort(x, y) { 
        var cRect = this.container.getBoundingClientRect();
        var ports = document.querySelectorAll('.bbu-port, .port-gps, .port-gps-sma, .port-qsfp, .port-usb-v, .port-power-in'); 
        for (var p of ports) { 
            var r = p.getBoundingClientRect(); 
            var pX = r.left - cRect.left; 
            var pY = r.top - cRect.top;
            if (Math.abs(x - (pX + r.width/2)) < 15 && Math.abs(y - (pY + r.height/2)) < 15) {
                return { element: p, slot: p.getAttribute('data-slot'), pid: p.getAttribute('data-pid') };
            }
        } return null;
    }
    
    getAllCables() { return this.cables; }
    setCables(newCables) { this.cables = newCables; this.render(); }
    clearCables() { this.cables = []; this.render(); }

} // --- FIM DA CLASSE CABLEMANAGER ---

// =========================================================
// --- 3. INICIALIZAÇÃO E FUNÇÕES GERAIS ---
// =========================================================

window.onload = function() {
    cableManager = new CableManager();
    
    // Torna a caixa de peças arrastável
    makeDraggable(document.getElementById('partsBox'));
    
    setupListeners();
    createConfirmationModalUI();
    initInventory();
    
    if(typeof atualizarContadoresGeral === 'function') atualizarContadoresGeral();
    if(typeof atualizarPowerBudget === 'function') atualizarPowerBudget();
};

function showWelcomeTip() {
    var tip = document.getElementById('startTipOverlay');
    if(!tip) return;
    setTimeout(function() { tip.classList.add('show'); }, 500);
    setTimeout(function() { tip.classList.remove('show'); setTimeout(() => tip.style.display = 'none', 1000); }, 4000);
}

document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.key === ' ') { toggleInstructorPanel(); }
});

// Funções de ponte para o CableManager
function spawnSFP(e) { cableManager.spawnSFP(e); }
function spawnJumperCable() { cableManager.spawnJumperCable(); }
function spawnDummy(e) { cableManager.spawnDummy(e); }
function spawnUSB(e) { cableManager.spawnUSB(e); }
function spawnODUCable(type, boxId) { cableManager.spawnODUCable(type, boxId); }
function spawnUMPTCable() { cableManager.spawnUMPTCable(); }
function spawnGPSCable() { cableManager.spawnGPSCable(); }
function spawnDCDUCable() { cableManager.spawnDCDUCable(); }

// --- LOGICA DE DRAG (ARRASTAR CAIXAS) ---
function makeDraggable(element) {
    var pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    var header = element.querySelector('.sb-header');
    if (header) { header.onmousedown = dragMouseDown; }
    
    function dragMouseDown(e) { 
        e = e || window.event; 
        e.preventDefault(); 
        pos3 = e.clientX; 
        pos4 = e.clientY; 
        document.onmouseup = closeDragElement; 
        document.onmousemove = elementDrag; 
    }
    
    function elementDrag(e) { 
        e = e || window.event; 
        e.preventDefault(); 
        pos1 = pos3 - e.clientX; 
        pos2 = pos4 - e.clientY; 
        pos3 = e.clientX; 
        pos4 = e.clientY; 
        element.style.top = (element.offsetTop - pos2) + "px"; 
        element.style.left = (element.offsetLeft - pos1) + "px"; 
        if(cableManager) cableManager.render();
    }
    
    function closeDragElement() { 
        document.onmouseup = null; 
        document.onmousemove = null; 
    }
}

function setupListeners() {
    // Listeners dos Slots
    document.querySelectorAll('.bbu-slot').forEach(function(slot) {
        slot.addEventListener('click', function(e) { 
            if (e.shiftKey && isInstalledSlot(this)) { showDiagnostics(this.getAttribute('data-slot')); return; }
            if (this.classList.contains('slot-burnt')) { showNotification("Slot queimado.", "error"); return; } 
            if (this.classList.contains('slot-dummy')) { e.stopPropagation(); this.classList.remove('slot-dummy'); this.classList.add('bbu-slot-empty'); return; } 
        });
        slot.addEventListener('contextmenu', function(e) { e.preventDefault(); if(isInstalledSlot(this)) uninstallBoard(this); });
        slot.addEventListener('dblclick', function(e) { e.preventDefault(); e.stopPropagation(); if(isInstalledSlot(this)) uninstallBoard(this); });
    });

    // Listeners do Jogo de Polaridade
    window.addEventListener('mousemove', polyGameMove); 
    window.addEventListener('mouseup', polyGameUp);
    
    // Listener da Ventoinha
    var fanSlot = document.querySelector('.fan-slot');
    if (fanSlot) {
        fanSlot.addEventListener('dblclick', function() {
            if (activeFaults['slot_FAN']) {
                showCustomConfirm("A ventoinha apresenta falha. Deseja substituir a unidade de ventilação?", function() {
                    delete activeFaults['slot_FAN'];
                    showNotification("Unidade de ventilação substituída com sucesso.", "success");
                    manageSystemHealth(); 
                });
            } else {
                showNotification("Status Ventilação: OK (Rotação Nominal)", "success");
            }
        });
    }
}

function isInstalledSlot(slot) { 
    var slotId = parseInt(slot.getAttribute('data-slot'));
    if (isNaN(slotId)) return false;
    return (!slot.classList.contains('bbu-slot-empty') && !slot.classList.contains('slot-burnt') && !slot.classList.contains('fan-slot') && !slot.classList.contains('slot-dummy'));
}

function showNotification(msg, type) { 
    if(!type) type='warning'; 
    var container = document.getElementById('toast-container');
    
    var iconName = type === 'success' ? 'check_circle' : (type === 'error' ? 'error' : 'warning'); 
    var toast = document.createElement('div');
    toast.className = 'toast-card toast-' + type;
    toast.innerHTML = '<span class="material-icons">' + iconName + '</span><div>' + msg + '</div>'; 
    
    container.appendChild(toast);

    while (container.children.length > 3) {
        container.removeChild(container.firstChild);
    }

    setTimeout(function() { 
        if(toast.parentNode) toast.remove(); 
    }, 4000);
}
var courseState = { active: false, currentIdx: 0, completedModules: [], isTheoryRead: false };

 // =========================================================
  // --- 4. MÓDULOS DO CURSO (LÓGICA E VALIDAÇÃO) ---
  // =========================================================
  var COURSE_MODULES = [
      {
          id: 0, title: "INTRODUÇÃO",
          desc: "Bem-vindo. Estude a teoria inicial e valide para começar.",
          objectives: ["Clique em 'ESTUDAR TEORIA'.", "Leia o conteúdo e confirme.", "Clique em 'VALIDAR TAREFA'.", "Clique na seta abaixo para avançar."],
          setup: function() { 
              limparSimulacao(false); }, 
          validate: function() { return { passed: true, msg: "Introdução concluída."
          }; }
      },
      {
          id: 1, title: "MÓDULO 1: ARQUITETURA DE HARDWARE",
          desc: "Instale as placas corretas nos slots designados.",
          objectives: ["Instale UMPT (Slots 6 ou 7).", "Instale UBBP (Slots 0-5).", "Instale UPEU (Slots 18/19).", "Instale Tampas (Dummy) nos vazios.", "Clique em 'VALIDAR TAREFA'."],
          setup: function() {
              limparSimulacao();
              showNotification("Cenário: BBU vazia. Consulte a teoria para distribuição de slots.", "warning");
          },
          validate: function() {
              // 1. Validação Visual Direta (O que está na tela?)
              // Verifica UMPT (Slots 6 ou 7)
              var s6 = document.getElementById('bbuSlot6');
              var s7 = document.getElementById('bbuSlot7');
              // Verifica se tem placa (label instalado) em um dos dois
              var hasUMPT = (s6.querySelector('.installed-board-label') || s7.querySelector('.installed-board-label'));
              
              if (!hasUMPT) return { passed: false, msg: "Faltou a placa UMPT (Controle) no Slot 6 ou 7." };

              // Verifica UBBP (Slots 0 a 5) - Pelo menos uma
              var hasUBBP = false;
              for(var i=0; i<=5; i++) {
                  if(document.getElementById('bbuSlot'+i).querySelector('.installed-board-label')) hasUBBP = true;
              }
              if (!hasUBBP) return { passed: false, msg: "Instale pelo menos uma placa UBBP (Processamento) entre os Slots 0 e 5." };

              // 2. Validação dos Slots de Energia (18 e 19)
              var s18 = document.getElementById('bbuSlot18');
              var s19 = document.getElementById('bbuSlot19');

              // Verifica se estão "Abertos" (Preto Vazio)
              // Se tiver Tampa OU Placa, a classe 'bbu-slot-empty' é removida.
              if (s18.classList.contains('bbu-slot-empty')) return { passed: false, msg: "O Slot 18 está aberto! Coloque uma UPEU ou uma Tampa." };
              if (s19.classList.contains('bbu-slot-empty')) return { passed: false, msg: "O Slot 19 está aberto! Coloque uma UPEU ou uma Tampa." };

              // Verifica se tem pelo menos UMA fonte de energia real (não apenas duas tampas)
              var upeuReal18 = s18.querySelector('.installed-board-label'); // Tem label? É placa.
              var upeuReal19 = s19.querySelector('.installed-board-label'); 

              if (!upeuReal18 && !upeuReal19) {
                  return { passed: false, msg: "Você fechou os slots com tampas, mas cadê a energia? Instale uma UPEU!" };
              }

              // 3. Validação de Slots Gerais (0 a 7) - Verifica buracos
              var slotsAbertos = [];
              for(var i=0; i<=7; i++) {
                  var slot = document.getElementById('bbuSlot'+i);
                  // Slot está vazio E não é o slot que sobrou da UMPT (exceção se quiser ser rigoroso)
                  if(slot.classList.contains('bbu-slot-empty')) {
                      slotsAbertos.push(i);
                  }
              }

              if (slotsAbertos.length > 0) {
                  return { passed: false, msg: "Ainda há buracos no chassi! Feche os slots: " + slotsAbertos.join(', ') };
              }
              
              return { passed: true, msg: "Hardware Perfeito! UMPT, UBBP e Energia (1+0 ou 1+1) validados." };
          }
      },
      {
          id: 2, title: "MÓDULO 2: CONECTIVIDADE E SETORES",
          desc: "Conecte as fibras ópticas nas placas UBBP.",
          objectives: ["Insira SFP nas portas da UBBP.", "Conecte fibra do Site Local.", "Configure Setor/Rádio no cabo. (clique no cabo)", "Clique em 'VALIDAR TAREFA'."],
          setup: function() {
              var inv = generateTechnicalData().inventory;
              if (!inv.some(b => b.type === 'UBBP')) installBoard(document.getElementById('bbuSlot0'), {model:"UBBPg3A (TN)", type:"UBBP"});
              cableManager.setCables(cableManager.cables.filter(c => c.sourceType !== 'LOCAL' && c.sourceType !== 'REMOTE'));
              cableManager.render();
          },
          validate: function() {
              var localCables = cableManager.cables.filter(c => c.sourceType === 'LOCAL' && c.connectedTo && c.connectedTo.includes("Slot"));
              if(localCables.length < 1) return { passed: false, msg: "Conecte fibra na UBBP." };
              if(localCables.some(c => !c.config.sector)) return { passed: false, msg: "Configure o Setor do cabo." };
              return { passed: true, msg: "Conectividade OK!" };
          }
      },
      {
          id: 3, title: "MÓDULO 3: CONTROLE (UMPT)",
          desc: "Conecte Backhaul e GPS na UMPT.",
          objectives: ["Insira SFP na UMPT (XGE0/XGE1/XGE2).", "Conecte cabo UMPT (Control).", "Conecte cabo de GPS.", "Clique em 'VALIDAR TAREFA'."],
          setup: function() {
              var inv = generateTechnicalData().inventory;
              if (!inv.some(b => b.type === 'UMPT')) installBoard(document.getElementById('bbuSlot7'), {model:"UMPTe (Control)", type:"UMPT"});
              cableManager.setCables(cableManager.cables.filter(c => c.sourceType !== 'UMPT' && c.sourceType !== 'GPS'));
              cableManager.render();
          },
          validate: function() {
              var hasTrans = cableManager.cables.some(c => c.sourceType === 'UMPT' && c.connectedTo);
              var hasGPS = cableManager.cables.some(c => c.sourceType === 'GPS' && c.connectedTo && c.connectedTo.includes('GPS'));
              if(!hasTrans) return { passed: false, msg: "Faltou Transmissão."
              };
              if(!hasGPS) return { passed: false, msg: "Faltou GPS." };
              return { passed: true, msg: "Controle OK!" };
          }
      },
      {
          id: 4, title: "MÓDULO 4: ENERGIA (UPEU)",
          desc: "Energize o sistema corretamente.",
          objectives: ["Instale a placa UPEU (se não houver).", "Conecte o cabo DCDU na porta PWR da placa.", "Ligue a chave da DCDU.", "Clique em 'VALIDAR TAREFA'."],
          setup: function() {
              cableManager.setCables(cableManager.cables.filter(c => c.sourceType !== 'ENERGY'));
              dcduSwitches = { 18: false, 19: false };
              if(document.getElementById('sw18')) document.getElementById('sw18').classList.remove('on');
              if(document.getElementById('sw19')) document.getElementById('sw19').classList.remove('on');
              cableManager.render();
              var dcdu = document.getElementById('dcduBox');
              if(dcdu.style.display === 'none') showNotification("Complete módulos anteriores para ver a DCDU.", "error");
          },
          validate: function() {
              var pData = atualizarPowerBudget();
              if(pData.capacity === 0) return { passed: false, msg: "Sistema sem energia." };
              if(pData.overloaded) return { passed: false, msg: "Sobrecarga de energia!" };
              return { passed: true, msg: "Energia OK!" };
          }
      },
      {
          id: 5, title: "MÓDULO 5: CAPACIDADE",
          desc: "Hardware antigo não suporta 5G. Faça o upgrade.",
          objectives: ["Identifique erro de Overload no Slot 0.", "Remova a placa obsoleta.", "Instale uma placa mais nova.", "Clique em 'VALIDAR TAREFA'."],
          setup: function() {
              var slot0 = document.getElementById('bbuSlot0');
              if(!slot0.classList.contains('bbu-slot-empty')) uninstallBoard(slot0, true);
              installBoard(slot0, {model:"UBBPg1a (TN)", type:"UBBP"});
              showNotification("Cenário: Placa obsoleta causando gargalo.", "warning");
          },
          validate: function() {
              var slot0 = document.getElementById('bbuSlot0');
              if(slot0.classList.contains('bbu-slot-empty')) return { passed: true, msg: "Placa removida. OK!" };
              var label = slot0.querySelector('.installed-board-label').innerText;
              if(label.includes('UBBPg1a')) return { passed: false, msg: "Placa antiga ainda instalada." };
              return { passed: true, msg: "Upgrade realizado!" };
          }
      },
      {
          id: 6, title: "MÓDULO 6: TROUBLESHOOTING",
          desc: "Falha crítica de temperatura.",
          objectives: ["Identifique o alarme (FAN FAIL).", "Troque a ventoinha com Duplo clique.", "Clique em 'VALIDAR TAREFA'."],
          setup: function() {
              activeFaults['slot_FAN'] = 'FAN_FAIL';
              var fanSlot = document.querySelector('.fan-slot');
              if(fanSlot) fanSlot.classList.add('fan-broken');
              manageSystemHealth();
          },
          validate: function() {
              if(activeFaults['slot_FAN']) return { passed: false, msg: "Ventoinha ainda quebrada."
              };
              return { passed: true, msg: "Falha corrigida!" };
          }
      },
      {
          id: 7, title: "MÓDULO 7: DEPLOY FINAL",
          desc: "Validação final do site.",
          objectives: ["Verifique todas as conexões.", "Garanta zero alarmes.", "configuração lógica (IP). Use o Console: SET DEVIP.", "Clique no botão DEPLOY.", "Clique em 'VALIDAR TAREFA'."],
          setup: function() { activeFaults = {};
          },
          validate: function() {
              var err = validarAntesDoDeploy();
              if(err.length > 0) return { passed: false, msg: "Erro: " + err[0] };
              return { passed: true, msg: "Site pronto para Deploy!" };
          }
      },
      {
          id: 8, title: "MÓDULO 8: Instalação de Torre (Teoria)",
          desc: "Procedimentos de instalação de RRU em torre.",
          objectives: ["Leia a teoria sobre instalação.", "Clique em 'VALIDAR TAREFA' para concluir."],
          setup: function() {
              // Limpa qualquer estado anterior, mas não desenha nada nem força caixas
              towerState = { active: false, hasBracket: false, hasRRU: false, isGrounded: false, cableConnected: false, isWeatherproofed: false };
              
              // Apenas avisa que é um módulo de leitura
              showNotification("Módulo Teórico. Estude o conteúdo e valide.", "info");
          },
          validate: function() {
              // Validação automática (Instant Pass)
              // Como o objetivo é apenas ler a teoria, não verificamos cabos ou peças.
              return { passed: true, msg: "Módulo teórico concluído!" };
          }
      }
  ];

  function toggleCoursePanel() {
      var panel = document.getElementById('coursePanel');
      if (panel.style.display === 'none') {
          panel.style.display = 'flex';
          courseState.active = true;
          loadModule(courseState.currentIdx);
      } else {
          panel.style.display = 'none';
          courseState.active = false;
      }
  }

  function loadModule(idx) {
      if (idx < 0 || idx >= COURSE_MODULES.length) return;
      courseState.currentIdx = idx;
      courseState.isTheoryRead = false; 

      var mod = COURSE_MODULES[idx];
      document.getElementById('courseTitle').innerText = mod.title;
      document.getElementById('courseDescription').innerText = mod.desc;
      var ul = document.getElementById('courseObjectivesList');
      ul.innerHTML = '';
      mod.objectives.forEach(obj => {
          var li = document.createElement('li');
          li.innerText = obj;
          ul.appendChild(li);
      });
      document.getElementById('courseFeedback').innerText = "Aguardando...";
      document.getElementById('courseFeedback').className = "course-feedback";
      document.getElementById('lblModuleProgress').innerText = idx + " / " + (COURSE_MODULES.length - 1);
      var btnCheck = document.getElementById('btnCheckModule');
      btnCheck.disabled = true;
      btnCheck.innerText = "🔒 LEIA A TEORIA";
      
      var btnStudy = document.getElementById('btnStudyTheory');
      btnStudy.classList.add('blink-highlight');
      var finalPanel = document.getElementById('panelFinalReport');
      if(finalPanel) finalPanel.style.display = 'none';

      if(mod.setup) mod.setup();
  }

  function openTheory() {
      var content = COURSE_THEORY[courseState.currentIdx] ||
      "<p>Conteúdo não disponível.</p>";
      document.getElementById('theoryContent').innerHTML = content;
      document.getElementById('theoryTitleText').innerText = "TEORIA - " + COURSE_MODULES[courseState.currentIdx].title;
      document.getElementById('theoryModal').style.display = 'flex';
  }

  function closeTheory() { document.getElementById('theoryModal').style.display = 'none'; }

  function finishTheory() {
      courseState.isTheoryRead = true;
      closeTheory();
      var btnCheck = document.getElementById('btnCheckModule');
      btnCheck.disabled = false;
      btnCheck.innerText = "VALIDAR TAREFA";
      showNotification("Teoria compreendida. Prática liberada!", "success");
  }

  function switchTheoryTab(tabId) {
      document.querySelectorAll('.theory-tab-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.btn-theory-tab').forEach(el => el.classList.remove('active'));
      document.getElementById(tabId).classList.add('active');
      event.target.classList.add('active');
  }

  function checkModuleCompletion() {
      if (!courseState.isTheoryRead) {
          showNotification("Você precisa ler a teoria antes de validar!", "error");
          return;
      }

      var mod = COURSE_MODULES[courseState.currentIdx];
      var result = mod.validate();
      var fb = document.getElementById('courseFeedback');
      fb.innerText = result.msg;
      
      if (result.passed) {
          fb.className = "course-feedback success";
          if(!courseState.completedModules.includes(courseState.currentIdx)) {
              courseState.completedModules.push(courseState.currentIdx);
          }
          
          var grid = document.getElementById('bbuGrid');
          grid.classList.add('bbu-glow-on');
          setTimeout(() => grid.classList.remove('bbu-glow-on'), 2000);

          if (courseState.currentIdx === COURSE_MODULES.length - 1) {
              showCourseCompletionAnimation();
          } else {
              showNotification("Módulo Concluído!", "success");
          }
      } else {
          fb.className = "course-feedback error";
          showNotification("Tarefa incompleta.", "error");
      }
  }

  function showCourseCompletionAnimation() {
      showNotification("PARABÉNS! CURSO COMPLETO!", "success");
      var grid = document.getElementById('bbuGrid');
      if(grid) {
          grid.classList.add('bbu-glow-on');
          setTimeout(() => grid.classList.remove('bbu-glow-on'), 4000);
      }
      var finalPanel = document.getElementById('panelFinalReport');
      if(finalPanel) {
          finalPanel.style.display = 'flex'; 
          finalPanel.style.animation = 'slideUp 0.5s ease-out';
      }
  }

  function nextModule() {
      if (courseState.currentIdx > 0 && !courseState.completedModules.includes(courseState.currentIdx)) {
          showNotification("Complete a tarefa atual antes de avançar!", "warning");
          return;
      }
      if (courseState.currentIdx < COURSE_MODULES.length - 1) {
          loadModule(courseState.currentIdx + 1);
      }
  }
  
  function prevModule() {
      if (courseState.currentIdx > 0) {
          loadModule(courseState.currentIdx - 1);
      }
  }
// ===========================================
// BBU ARCHITECT SIMULATOR - SCRIPT.JS (Parte 4/5)
// =========================================================

function iniciarSimulacao() {
    var sBBU = document.getElementById('inSiteBBU').value;
    var sCentral = document.getElementById('inSiteCentral').value.trim();
    
    siteNames.local = sBBU || "LOCAL";
    document.getElementById('txtLocal').innerText = siteNames.local;
    
    var boxRemote = document.getElementById('oduRemote');
    var headerRemote = document.getElementById('headerRemote');

    // --- LÓGICA DA PILHA (STACK) ---
    if (sCentral === "") {
        // MODO SINGLE SITE (Sem Remoto Inicial)
        siteNames.remote = null;
        if(boxRemote) boxRemote.style.display = 'none';
        
        // A pilha começa no 0 (Só o Local existe)
        // O próximo site criado irá para o slot 1 (220px)
        siteStackLevel = 0; 
        
        showNotification("Modo Single Site ativado.", "success");
    } else {
        // MODO DUAL SITE (Com Remoto Inicial)
        siteNames.remote = sCentral;
        document.getElementById('txtRemote').innerText = siteNames.remote;
        
        if(boxRemote) {
            boxRemote.style.display = 'flex';
            // Posiciona ele no Slot 1 (Logo abaixo do Local)
            boxRemote.style.top = "220px"; 
        }
        if(headerRemote) headerRemote.innerText = "SITE REMOTO";
        
        // A pilha já está no nível 1
        // O próximo site criado irá para o slot 2 (340px)
        siteStackLevel = 1; 
    }
    // -------------------------------
    
    document.getElementById('setupModalOverlay').style.display = 'none';
    document.getElementById('simContainer').style.display = 'block';
    
    // ... resto das inicializações (inventory, power, etc) ...
    initInventory();
    atualizarContadoresGeral();
    atualizarPowerBudget();
    setTimeout(iniciarTutorial, 500);
}
function initInventory() {
    var container = document.getElementById('invList');
    container.innerHTML = '';
    availableBoards.forEach(function(board) {
        var card = document.createElement('div'); card.className = 'board-card';
        if(board.type === 'UMPT') card.classList.add('umpt-card');
        if(board.type === 'UPEU') card.classList.add('upeu-card'); 
        card.innerHTML = '<span class="board-name">' + board.model + '</span><span class="board-type">' + board.type + '</span>';
        card.onmousedown = function(e) { startBoardDrag(e, board); };
        container.appendChild(card);
    });
}

function uninstallBoard(slotElement, skipConfirm) {
    if(skipConfirm) { 
        proceedUninstall(slotElement, true);
    } else {
        showCustomConfirm('Remover placa do slot ' + slotElement.getAttribute('data-slot') + '?', function() { proceedUninstall(slotElement, false); });
    }
}

function proceedUninstall(slotElement, skipConfirm) {
    var slotId = slotElement.getAttribute('data-slot');
    
    // 1. Remove cabos conectados
    var cablesToRemove = cableManager.cables.filter(c => (c.connectedTo && c.connectedTo.includes("Slot " + slotId)) || (c.connectedToStart && c.connectedToStart.includes("Slot " + slotId)));
    if(cablesToRemove.length > 0) { 
        cableManager.setCables(cableManager.cables.filter(c => !((c.connectedTo && c.connectedTo.includes("Slot " + slotId)) || (c.connectedToStart && c.connectedToStart.includes("Slot " + slotId)))));
        cableManager.render(); 
    }
    
    // 2. Reseta o Slot para o estado VAZIO
    slotElement.onmousedown = null; 
    slotElement.className = 'bbu-slot bbu-slot-empty';
    slotElement.removeAttribute('title');
    slotElement.style.boxShadow = "none"; 
    slotElement.classList.remove('slot-overheat', 'slot-overload');
    
    // RESTAURA O DATA-ACCEPT CORRETO
    if (slotId === '18' || slotId === '19') {
        slotElement.setAttribute('data-accept', 'UPEU');
    } else if (slotId === '6' || slotId === '7') {
        slotElement.setAttribute('data-accept', 'UMPT');
    } else {
        slotElement.setAttribute('data-accept', 'UBBP');
    }

    // 3. Limpa visualmente o conteúdo (remove faceplate antiga)
    while (slotElement.firstChild) { slotElement.removeChild(slotElement.firstChild); }
    
    // 4. Recria o Label do Slot
    var span = document.createElement('span');
    span.className = "slot-id-label";
    span.innerText = "SLOT " + slotId;
    if (slotId == 18 || slotId == 19) span.style.color = '#e74c3c';
    if (slotId == 6 || slotId == 7) span.style.color = '#f37021';
    slotElement.appendChild(span);

    // 5. Desliga lógica da UMPT se for o caso
    if(umptStates[slotId]) { 
        umptStates[slotId] = 'OFF'; 
        if(bootTimers[slotId]) clearTimeout(bootTimers[slotId]);
    }
    
    var faultKey = "slot_" + slotId;
    if (activeFaults[faultKey]) { 
        delete activeFaults[faultKey];
        showNotification("Hardware substituído. Falha limpa.", "success");
    }
    
    if(!skipConfirm) showNotification("Placa removida.", "success");
    
    // Funções globais de verificação (definidas na parte 5 ou já carregadas)
    if(typeof atualizarPowerBudget === 'function') atualizarPowerBudget(); 
    if(typeof manageSystemHealth === 'function') manageSystemHealth(); 
    if(typeof verificarEstadoSimulador === 'function') verificarEstadoSimulador(); 
    if(typeof validarCapacidadeBBU === 'function') validarCapacidadeBBU();
}

// --- LOGICA DRAG & DROP PLACAS ---

function startBoardDrag(e, boardData) { 
    e.preventDefault(); 
    isDraggingBoard = true;
    draggedBoardData = boardData; 
    draggedFromSlot = null; 
    createBoardGhost(e, boardData.model); 
}

function startBoardRemovalDrag(e, slotElement, boardData) { 
    if(e.target.classList.contains('bbu-port') || e.target.classList.contains('sfp-cage') || e.target.tagName === 'circle' || e.target.classList.contains('port-power-in')) return;
    e.preventDefault(); 
    e.stopPropagation(); 
    isDraggingBoard = true;
    draggedBoardData = boardData; 
    draggedFromSlot = slotElement; 
    createBoardGhost(e, boardData.model);
}

function createBoardGhost(e, text) { 
    draggedBoardGhost = document.createElement('div'); 
    draggedBoardGhost.className = 'draggable-board-ghost';
    draggedBoardGhost.innerText = text; 
    document.body.appendChild(draggedBoardGhost); 
    moveBoardGhost(e); 
    document.addEventListener('mousemove', moveBoardGhost); 
    document.addEventListener('mouseup', dropBoard); 
}

function moveBoardGhost(e) { 
    if(!draggedBoardGhost) return;
    draggedBoardGhost.style.left = (e.clientX + 10) + 'px'; 
    draggedBoardGhost.style.top = (e.clientY + 10) + 'px'; 
    checkSlotHover(e.clientX, e.clientY);
}

function checkSlotHover(x, y) { 
    document.querySelectorAll('.bbu-slot').forEach(el => el.classList.remove('drag-over')); 
    var elBelow = document.elementFromPoint(x, y);
    var slot = elBelow ? elBelow.closest('.bbu-slot') : null; 
    if (slot && slot.classList.contains('bbu-slot-empty')) { 
        var slotAccepts = slot.getAttribute('data-accept');
        if (slotAccepts === draggedBoardData.type) slot.classList.add('drag-over');
    } 
}

function dropBoard(e) { 
    document.removeEventListener('mousemove', moveBoardGhost);
    document.removeEventListener('mouseup', dropBoard);
    if (draggedBoardGhost) draggedBoardGhost.remove();
    draggedBoardGhost = null; 
    
    var elBelow = document.elementFromPoint(e.clientX, e.clientY); 
    var slot = elBelow ? elBelow.closest('.bbu-slot') : null;
    
    if (draggedFromSlot === null) {
        if (slot && slot.classList.contains('bbu-slot-empty')) { 
            var slotAccepts = slot.getAttribute('data-accept');
            if (slotAccepts === draggedBoardData.type) installBoard(slot, draggedBoardData); 
            else showNotification("Slot incompatível!", "error");
        }
    } else {
        if (!slot || slot !== draggedFromSlot) { 
            uninstallBoard(draggedFromSlot, true);
            if (slot && slot.classList.contains('bbu-slot-empty')) { 
                var slotAccepts = slot.getAttribute('data-accept');
                if (slotAccepts === draggedBoardData.type) { 
                    installBoard(slot, draggedBoardData);
                    showNotification("Placa movida.", "success");
                } else { 
                    showNotification("Slot incompatível para mover.", "error");
                } 
            } else { 
                showNotification("Placa desinstalada.", "success");
            } 
        }
    }
    isDraggingBoard = false;
    draggedBoardData = null; 
    draggedFromSlot = null; 
    document.querySelectorAll('.bbu-slot').forEach(el => el.classList.remove('drag-over')); 
}

function installBoard(slotElement, boardData) {
    var slotId = slotElement.getAttribute('data-slot');
    slotElement.classList.remove('bbu-slot-empty'); 
    slotElement.setAttribute('title', 'Arraste para fora para remover'); 
    
    var label = slotElement.querySelector('.slot-id-label');
    if(label) label.innerHTML = 'SLOT ' + slotId + ' <span style="color:#777">| ' + boardData.model + '</span>';
    
    var nameTag = document.createElement('div');
    nameTag.className = 'installed-board-label'; 
    nameTag.innerText = boardData.model; 
    slotElement.appendChild(nameTag);
    
    // --- LAYOUT DA UBBP ---
    if (boardData.type === 'UBBP') {
        var html = '<div class="ubbp-faceplate"><div class="board-latch-left"></div><div class="board-latch-right"></div><div class="ubbp-port-row">';
        for(var i=0; i<6; i++) { 
            html += '<div class="port-wrapper"><div class="bbu-port sfp-cage" data-slot="'+slotId+'" data-pid="'+i+'"></div><span class="silk-port-label">'+i+'</span></div>';
        }
        html += '<div style="width:1px;background:#444;height:15px;margin:0 2px;"></div><div class="port-wrapper"><div class="bbu-port port-qsfp" data-slot="'+slotId+'" data-pid="HEI0"></div><span class="silk-port-label">HEI0</span></div><div class="port-wrapper"><div class="bbu-port port-qsfp" data-slot="'+slotId+'" data-pid="HEI1"></div><span class="silk-port-label">HEI1</span></div></div></div>';
        slotElement.insertAdjacentHTML('beforeend', html);
    } 
    // --- LAYOUT DA UMPT ---
    else if (boardData.type === 'UMPT') {
      var html = '<div class="umpt-faceplate" style="flex-direction:row; align-items:center; justify-content:space-between; padding:0 6px;">';
      html += '<div class="board-latch-left" style="background:#111; width:6px; height:6px; border-radius:50%; box-shadow:0 1px 1px #fff;"></div>';
      html += '<div class="metal-housing" style="display:flex; gap:2px; padding:2px; background:linear-gradient(to bottom, #bdc3c7, #95a5a6); border:1px solid #7f8c8d; border-radius:2px; box-shadow: inset 0 1px 2px rgba(255,255,255,0.5);">';
      html +=   '<div class="port-wrapper" style="margin:0;"><div class="bbu-port port-rj45" data-slot="'+slotId+'" data-pid="GE0"></div><span class="silk-port-label" style="color:#222; font-weight:bold;">GE0</span></div>';
      html +=   '<div class="port-wrapper" style="margin:0;"><div class="bbu-port port-rj45" data-slot="'+slotId+'" data-pid="GE1"></div><span class="silk-port-label" style="color:#222; font-weight:bold;">GE1</span></div>';
      html += '</div>';
      html += '<div class="port-wrapper"><div class="bbu-port port-usb-v" style="background:#333; border:2px solid #bdc3c7;" data-slot="'+slotId+'"></div><span class="silk-port-label">USB</span></div>';
      html += '<div style="display:flex; gap:3px;">';
      html +=   '<div class="port-wrapper"><div class="bbu-port sfp-cage" data-slot="'+slotId+'" data-pid="XGE0"></div><span class="silk-port-label">XGE0</span></div>';
      html +=   '<div class="port-wrapper"><div class="bbu-port sfp-cage" data-slot="'+slotId+'" data-pid="XGE1"></div><span class="silk-port-label">XGE1</span></div>';
      html +=   '<div class="port-wrapper"><div class="bbu-port sfp-cage" data-slot="'+slotId+'" data-pid="XGE2"></div><span class="silk-port-label">XGE2</span></div>';
      html += '</div>';
      html += '<div style="display:flex; align-items:center; gap:5px;">';
      html +=   '<div class="port-wrapper"><div class="bbu-port port-gps-sma" data-slot="'+slotId+'" data-pid="GPS"></div><span class="silk-port-label" style="margin-top:1px;">GPS</span></div>';
      html +=   '<div style="width:3px; height:3px; background:#000; border-radius:50%; margin-top:-5px; box-shadow: inset 0 0 1px #555;" title="RST"></div>';
      html += '</div>';
      html += '<div class="umpt-led-area" style="display:grid; grid-template-columns: 1fr 1fr; gap:2px; margin:0;">';
      html +=   '<div class="led-group"><div id="led_'+slotId+'_run" class="led-bulb"></div><span class="silk-label">RUN</span></div>';
      html +=   '<div class="led-group"><div id="led_'+slotId+'_alm" class="led-bulb"></div><span class="silk-label">ALM</span></div>';
      html +=   '<div class="led-group"><div id="led_'+slotId+'_act" class="led-bulb"></div><span class="silk-label">ACT</span></div>';
      html +=   '<div class="led-group"><div class="led-bulb" style="background:#333; box-shadow:none;"></div><span class="silk-label">BSY</span></div>';
      html += '</div>';
      html += '<div class="board-latch-right" style="background:#111; width:6px; height:6px; border-radius:50%; box-shadow:0 1px 1px #fff;"></div>';
      html += '</div>'; 
      slotElement.insertAdjacentHTML('beforeend', html);
      umptStates[slotId] = 'OFF';
    }
    // --- LAYOUT DA UPEU ---
    else if (boardData.type === 'UPEU') {
      var html = '<div class="upeu-faceplate" style="position:relative;">';
      html += '<div class="upeu-model-label" style="font-size:8px; color:#aaa; font-weight:bold; margin-bottom:5px;">' + boardData.model.split('(')[0] + '</div>';
      html += '<div class="umpt-led-area" style="display:flex; gap:8px; margin-bottom:10px; justify-content:center;">';
      html += '<div class="led-group"><div id="led_'+slotId+'_run" class="led-bulb"></div><span class="silk-label">RUN</span></div>';
      html += '<div class="led-group"><div id="led_'+slotId+'_alm" class="led-bulb"></div><span class="silk-label">ALM</span></div>';
      html += '</div>';
      html += '<div class="upeu-mon-row">'; 
      html += '<div class="port-wrapper"><div class="bbu-port port-rj45" data-slot="'+slotId+'" data-pid="MON0" title="Monitoramento 0"></div><span class="silk-port-label">MON0</span></div>';
      html += '<div class="port-wrapper"><div class="bbu-port port-rj45" data-slot="'+slotId+'" data-pid="MON1" title="Monitoramento 1"></div><span class="silk-port-label">MON1</span></div>';
      html += '</div>';
      html += '<div class="port-wrapper" style="position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);">';
      html += '<div class="bbu-port port-power-in" data-slot="'+slotId+'" data-pid="PWR" title="Entrada -48V DC">';
      html += '<div class="pwr-pin"></div><div class="pwr-pin"></div><div class="pwr-pin"></div>';
      html += '</div>';
      html += '<span class="silk-port-label">PWR</span>';
      html += '</div>';
      html += '</div>'; 
      slotElement.insertAdjacentHTML('beforeend', html);
    }
    
    slotElement.onmousedown = function(e) { startBoardRemovalDrag(e, slotElement, boardData); };
    
    // Listener para remover SFP ao clicar na porta (apenas se não estiver desenhando cabo)
    var newPorts = slotElement.querySelectorAll('.bbu-port');
    newPorts.forEach(function(port) {
        port.addEventListener('mousedown', function(e) {
              if (cableManager && cableManager.isDrawing) {
                  return; 
              }
              if (this.classList.contains('has-sfp')) { 
                  e.preventDefault(); 
                  e.stopPropagation(); 
                  
                  var portIdStr = "Slot " + this.getAttribute('data-slot') + " Port " + this.getAttribute('data-pid'); 
                  var isBusy = cableManager.cables.some(function(c){ return c.connectedTo === portIdStr || c.connectedToStart === portIdStr; }); 
                  
                  if (isBusy) { 
                      showNotification("Desconecte a fibra antes de remover o SFP!", "error"); 
                      return; 
                  } 
                  
                  this.classList.remove('has-sfp'); 
                  this.removeAttribute('data-has-sfp'); 
                  if(typeof spawnSFP === 'function') spawnSFP(e); 
              }
         });
    });

    showNotification(boardData.model + " instalada!", "success");
    
    if(typeof atualizarPowerBudget === 'function') atualizarPowerBudget();
    if(typeof validarCapacidadeBBU === 'function') validarCapacidadeBBU();
    if(typeof verificarEstadoSimulador === 'function') verificarEstadoSimulador(); 
}

function setUmptLed(slot, ledType, state) {
    var ledEl = document.getElementById('led_' + slot + '_' + ledType.toLowerCase());
    if (!ledEl) return;
    ledEl.className = 'led-bulb'; 
    if (state === 'led-green-solid') ledEl.classList.add('green'); 
    else if (state === 'led-red-solid') ledEl.classList.add('red');
    else if (state === 'led-green-blink') { ledEl.classList.add('green'); ledEl.classList.add('blink-green'); } 
    else if (state === 'led-red-blink') { ledEl.classList.add('red'); ledEl.classList.add('blink-red'); }
}

function manageSystemHealth() {
    // 1. Lógica de Transmissão (Alarme SCTP)
    if (isChassisPowered()) {
        if (transmissionState.isConfigured === false) {
            activeFaults['TRANS_IP'] = 'SCTP_LINK_FAULT';
        } else {
            if (activeFaults['TRANS_IP']) delete activeFaults['TRANS_IP'];
        }
    }
    
    // 2. Se não há energia, desliga tudo
    if (!isChassisPowered()) { 
        [6,7,18,19].forEach(s => { 
            umptStates[s] = 'OFF'; 
            if(bootTimers[s]) clearTimeout(bootTimers[s]); 
            setUmptLed(s, 'RUN', 'OFF'); setUmptLed(s, 'ALM', 'OFF'); setUmptLed(s, 'ACT', 'OFF'); 
        });
        document.querySelector('.fan-slot').classList.remove('fan-broken'); 
        return;
    }
    
    // 3. Gerencia FAN
    var fanSlot = document.querySelector('.fan-slot');
    if (activeFaults['slot_FAN'] === 'FAN_FAIL') { 
        fanSlot.classList.add('fan-broken');
        fanSlot.title = "Falha de Ventilação! Duplo clique para substituir."; 
    } else { 
        fanSlot.classList.remove('fan-broken');
        fanSlot.title = "Sistema de Ventilação OK"; 
    }

    // 4. Gerencia superaquecimento visual
    for(var i=0; i<=19; i++) {
      var slotNode = document.getElementById('bbuSlot' + i);
      if(slotNode && !slotNode.classList.contains('bbu-slot-empty')) {
           var fKey = "slot_" + i;
           if (!slotNode.classList.contains('slot-overload')) slotNode.classList.remove('slot-overheat');
           if (activeFaults[fKey] === 'OVERHEAT' || (activeFaults['slot_FAN'] === 'FAN_FAIL' && Math.random() > 0.6)) slotNode.classList.add('slot-overheat');
      }
    }

    // 5. LEDs da UPEU (Slots 18/19)
    [18, 19].forEach(slotId => {
        var slotEl = document.getElementById('bbuSlot' + slotId);
        if (slotEl && !slotEl.classList.contains('bbu-slot-empty')) {
            var cable = cableManager.cables.find(c => c.connectedTo === "Slot " + slotId + " Port PWR");
            var isPowered = (cable && dcduSwitches[slotId] && cable.polarityStatus === 'CORRECT');
            
            if(isPowered) {
                setUmptLed(slotId, 'RUN', 'led-green-blink');
                if(activeFaults['slot_FAN'] === 'FAN_FAIL') setUmptLed(slotId, 'ALM', 'led-red-blink');
                else setUmptLed(slotId, 'ALM', 'OFF');
            } else {
                setUmptLed(slotId, 'RUN', 'OFF');
                setUmptLed(slotId, 'ALM', 'OFF');
            }
        }
    });

    // 6. LEDs da UMPT (Slots 6/7)
    [6, 7].forEach(slotId => {
        var slotEl = document.getElementById('bbuSlot' + slotId); 
        if(slotEl.classList.contains('bbu-slot-empty')) return;
        
        if (umptStates[slotId] === 'OFF') {
            umptStates[slotId] = 'BOOTING'; 
            setUmptLed(slotId, 'RUN', 'led-green-blink'); 
            setUmptLed(slotId, 'ALM', 'OFF');
            bootTimers[slotId] = setTimeout(() => { 
                if(isChassisPowered()) { 
                    umptStates[slotId] = 'RUNNING'; 
                    manageSystemHealth(); 
                } 
            }, 4000);
        }
        
        if(umptStates[slotId] === 'RUNNING') { 
            var faultKey = "slot_" + slotId; 
            var currentFault = activeFaults[faultKey]; 
            var fanFault = activeFaults['slot_FAN'];
            
            setUmptLed(slotId, 'RUN', 'led-green-solid');
            
            if (currentFault === 'OVERHEAT' || fanFault === 'FAN_FAIL') { 
                setUmptLed(slotId, 'ALM', 'led-red-blink');
            } else if (currentFault === 'SFP_FAIL') { 
                setUmptLed(slotId, 'ALM', 'led-red-solid');
            } else { 
                var hasGPS = cableManager.cables.some(c => c.connectedTo === "Slot " + slotId + " Port GPS");
                if(!hasGPS) setUmptLed(slotId, 'ALM', 'led-red-solid'); else setUmptLed(slotId, 'ALM', 'OFF'); 
            }
            
            var hasTrans = cableManager.cables.some(c => c.connectedTo && c.connectedTo.includes("Slot "+slotId));
            if(hasTrans) setUmptLed(slotId, 'ACT', 'led-green-blink'); else setUmptLed(slotId, 'ACT', 'OFF');
        }
    });
}

function autoFillDummies() { 
    var slots = document.querySelectorAll('.bbu-slot.bbu-slot-empty'); 
    var count = 0;
    slots.forEach(function(slot){ 
        if(!slot.classList.contains('slot-burnt')) { 
            slot.classList.remove('bbu-slot-empty'); 
            slot.classList.add('slot-dummy'); 
            count++; 
        } 
    }); 
    if(count > 0) showNotification(count + " Tampas instaladas.", "success");
}
// =========================================================
// BBU ARCHITECT SIMULATOR - SCRIPT.JS (Parte 5-1)
// =========================================================

// --- 6. UTILITÁRIOS: USB, SITES, CONTADORES ---

function removerUSB(element) { 
    element.remove();
    showNotification("Pen Drive removido com segurança.", "success"); 
    var modal = document.getElementById('usbInstallModal');
    if(modal.style.display === 'block') { 
        modal.style.display = 'none'; 
        showNotification("Instalação interrompida.", "error");
    } 
}

function iniciarInstalacaoUSB(slotId) {
    var modal = document.getElementById('usbInstallModal');
    var bar = document.getElementById('usbProgressBar');
    var txt = document.querySelector('.usb-status-text');
    modal.style.display = 'block'; 
    bar.style.width = '0%'; 
    txt.innerText = "Não desconecte o dispositivo...";
    
    var width = 0;
    var interval = setInterval(function() { 
        width += Math.random() * 5; 
        if (modal.style.display === 'none') { clearInterval(interval); return; } 
        if (width >= 100) { 
            width = 100; 
            bar.style.width = '100%'; 
            clearInterval(interval); 
            txt.innerText = "Concluído."; 
            showNotification("Arquivos instalados. Remova o Pen Drive.", "success"); 
            setTimeout(function() { modal.style.display = 'none'; }, 2000); 
        } else { 
            bar.style.width = width + '%'; 
        } 
    }, 100);
}

function openAddSiteModal() { 
    document.getElementById('inNewSiteName').value = "Site " + (remoteSiteCounter + 1); 
    document.getElementById('newSiteModalOverlay').style.display = 'flex'; 
    document.getElementById('inNewSiteName').focus();
}

function closeAddSiteModal() { document.getElementById('newSiteModalOverlay').style.display = 'none'; }

function confirmAddSite() { 
    var name = document.getElementById('inNewSiteName').value;
    if (!name) return showNotification("Digite um nome para o site.", "warning"); 
    closeAddSiteModal(); 
    createSiteBox(name);
}

function createSiteBox(name, customId, customTop, customLeft) {
    var newId = customId || ("oduDynamic_" + Date.now());
    var color = SITE_COLORS[Math.floor(Math.random() * SITE_COLORS.length)];
    
    var leftPos;
    var topPos;

    if (customTop && customLeft) {
        topPos = parseFloat(customTop);
        leftPos = parseFloat(customLeft);
        var estimatedLevel = Math.round((topPos - 100) / 120);
        if(estimatedLevel > siteStackLevel) siteStackLevel = estimatedLevel;
    } else {
        siteStackLevel++; 
        leftPos = 50; 
        topPos = 100 + (siteStackLevel * 120);
    }

    var html = `<div class="source-box-base odu-compact-box draggable-box" id="${newId}" style="top:${topPos}px; left:${leftPos}px; border-top: 3px solid ${color}; z-index:60;"><div class="sb-header" style="color:${color}; cursor:default;">${name.toUpperCase()}</div><div class="sb-body odu-compact-body"><span class="site-name-display">${name}</span><div style="display:flex; align-items:center;"><button class="btn-compact-add" onclick="spawnODUCable('REMOTE', '${newId}')">+</button><span id="count_${newId}" class="compact-counter">0/6</span></div></div></div>`;
    
    document.getElementById('simContainer').insertAdjacentHTML('beforeend', html);
    makeDraggable(document.getElementById(newId)); // Torna o novo site arrastável
    
    if(!customId) showNotification("Site criado: " + name, "success");
}

function atualizarContadoresGeral() { 
    // 1. Site Local
    var countLocal = cableManager.cables.filter(c => c.sourceType === 'LOCAL').length;
    document.getElementById('countLocal').innerText = countLocal + "/6"; 
    document.getElementById('btnLocal').disabled = (countLocal >= 6);    
    
    // 2. Site Remoto Padrão
    var countRemote = cableManager.cables.filter(c => c.boxId === 'oduRemote').length;
    var lblRemote = document.getElementById('countRemote_oduRemote'); 
    if(lblRemote) lblRemote.innerText = countRemote + "/6";              
    var btnRemote = document.getElementById('btnRemote');
    if(btnRemote) btnRemote.disabled = (countRemote >= 6);               

    // 3. Sites Dinâmicos
    document.querySelectorAll('[id^="oduDynamic_"]').forEach(el => { 
        var id = el.id; 
        var count = cableManager.cables.filter(c => c.boxId === id).length; 
        var lbl = document.getElementById('count_'+id); 
        if(lbl) lbl.innerText = count + "/6";                            
        var btn = el.querySelector('.btn-compact-add'); 
        if(btn) btn.disabled = (count >= 6);                             
    });

    updateBoxCount('UMPT', 2, 'countUmpt', 'btnUmpt'); 
    updateBoxCount('ENERGY', 2, 'countPwr', 'btnPwr'); 
    updateBoxCount('GPS', 2, 'countGps', 'btnGps');
}

function updateBoxCount(type, limit, lblId, btnId) { 
    var qtd = cableManager.cables.filter(c => c.sourceType === type).length;
    document.getElementById(lblId).innerText = qtd + "/" + limit; 
    document.getElementById(btnId).style.backgroundColor = (qtd >= limit) ? "#555" : "#2ecc71";
}

// --- 7. ENERGIA & POLARIDADE ---

function toggleSwitch(id) { 
    var sw = document.getElementById('sw' + id);
    var currentState = dcduSwitches[id];
    if (!currentState) { 
        var cable = cableManager.cables.find(c => c.connectedTo && c.connectedTo.includes("Slot " + id + " Port PWR"));
        if (cable && cable.polarityStatus === 'INVERTED') { 
            document.getElementById('bbuGrid').classList.add('bbu-flash-error'); 
            showNotification("ERRO: Polaridade Invertida!", "error"); 
            setTimeout(function(){ document.getElementById('bbuGrid').classList.remove('bbu-flash-error'); }, 2000); 
            return;
        } 
        dcduSwitches[id] = true; 
        sw.classList.add('on');
    } else { 
        dcduSwitches[id] = false; 
        sw.classList.remove('on'); 
    } 
    verificarEstadoSimulador(); 
    atualizarPowerBudget(); 
    manageSystemHealth();
}

function burnSlot(slotId) { 
    showNotification("ARCO VOLTAICO!", "error");
    var slotEl = document.getElementById('bbuSlot' + slotId);
    if(slotEl) slotEl.classList.add('slot-burnt');
    
    dcduSwitches[slotId] = false; 
    var sw = document.getElementById('sw' + slotId); 
    if(sw) sw.classList.remove('on');
    
    var cable = cableManager.cables.find(c => c.connectedTo && c.connectedTo.includes("Slot " + slotId));
    if(cable) { 
        cableManager.cables = cableManager.cables.filter(c => c.id !== cable.id);
        cableManager.render();
    } 
    verificarEstadoSimulador(); 
    atualizarPowerBudget(); 
    manageSystemHealth();
}

function openPolarityModal(cable) { 
    tempCableForPolarity = cable;
    polyConnections = []; 
    document.getElementById('polyLines').innerHTML = ''; 
    document.getElementById('polarityModal').style.display = 'flex'; 
}

function cancelPolarity() { 
    document.getElementById('polarityModal').style.display = 'none';
    if(tempCableForPolarity) tempCableForPolarity.connectedTo = null; 
    tempCableForPolarity = null; 
    cableManager.render(); 
}

function confirmPolarity() { 
    var blue = polyConnections.find(c => c.wire === 'blue');
    var black = polyConnections.find(c => c.wire === 'black'); 
    if (!blue || !black) return showNotification("Conecte ambos.", "warning");
    
    if (blue.term === 'pos' && black.term === 'neg') { 
        tempCableForPolarity.polarityStatus = 'CORRECT'; 
        showNotification("Polaridade OK!", "success");
    } else { 
        tempCableForPolarity.polarityStatus = 'INVERTED'; 
        showNotification("Invertido!", "warning"); 
    } 
    document.getElementById('polarityModal').style.display = 'none'; 
    cableManager.render(); 
    verificarEstadoSimulador(); 
    atualizarPowerBudget(); 
    manageSystemHealth(); 
    tempCableForPolarity = null;
}

function startPolyDrag(e, color) { 
    e.preventDefault(); 
    polyConnections = polyConnections.filter(c => c.wire !== color); 
    drawPolyLines(); 
    var rect = e.target.getBoundingClientRect();
    var svgRect = document.getElementById('polyLines').getBoundingClientRect(); 
    polyDragState.active = true; 
    polyDragState.wireColor = color; 
    polyDragState.startX = (rect.left + rect.width/2) - svgRect.left;
    polyDragState.startY = (rect.top + rect.height/2) - svgRect.top; 
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path"); 
    path.setAttribute("stroke", color === 'blue' ? '#3498db' : '#222');
    path.setAttribute("stroke-width", "6"); 
    path.setAttribute("fill", "none"); 
    document.getElementById('polyLines').appendChild(path); 
    polyDragState.tempLine = path; 
}

function polyGameMove(e) { 
    if (!polyDragState.active) return; 
    var svgRect = document.getElementById('polyLines').getBoundingClientRect();
    var x = e.clientX - svgRect.left; 
    var y = e.clientY - svgRect.top; 
    var cpX = (polyDragState.startX + x) / 2;
    var cpY = Math.max(polyDragState.startY, y) + 40; 
    polyDragState.tempLine.setAttribute("d", "M " + polyDragState.startX + " " + polyDragState.startY + " Q " + cpX + " " + cpY + " " + x + " " + y);
}

function polyGameUp(e) { 
    if (!polyDragState.active) return; 
    polyDragState.active = false; 
    if(polyDragState.tempLine) polyDragState.tempLine.remove();
    var terminals = [ { id: 'pos', el: document.getElementById('termPos') }, { id: 'neg', el: document.getElementById('termNeg') } ];
    var hit = null; 
    for(var t of terminals) { 
        var r = t.el.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) hit = t.id;
    } 
    if (hit) { 
        polyConnections.push({ wire: polyDragState.wireColor, term: hit }); 
        drawPolyLines();
    } 
}

function drawPolyLines() { 
    var svg = document.getElementById('polyLines'); 
    svg.innerHTML = '';
    polyConnections.forEach(function(conn){ 
        var wireEl = document.querySelector('.wire-' + conn.wire); 
        var termEl = document.getElementById(conn.term === 'pos' ? 'termPos' : 'termNeg'); 
        if(wireEl && termEl) { 
            var r1 = wireEl.getBoundingClientRect(); 
            var r2 = termEl.getBoundingClientRect(); 
            var svgRect = svg.getBoundingClientRect(); 
            var x1 = (r1.left + r1.width/2) - svgRect.left; 
            var y1 = (r1.top + r1.height/2) - svgRect.top; 
            var x2 = (r2.left + r2.width/2) - svgRect.left; 
            var y2 = (r2.top + r2.height/2) - svgRect.top; 
            var path = document.createElementNS("http://www.w3.org/2000/svg", "path"); 
            path.setAttribute("d", "M " + x1 + " " + y1 + " Q " + ((x1+x2)/2) + " " + (Math.max(y1,y2)+40) + " " + x2 + " " + y2); 
            path.setAttribute("stroke", conn.wire === 'blue' ? '#3498db' : '#222'); 
            path.setAttribute("stroke-width", "6"); 
            path.setAttribute("fill", "none"); 
            svg.appendChild(path); 
        } 
    });
}

// --- 8. CONFIGURAÇÃO DE CABOS & CAPACIDADE ---

function abrirConfigCabo(id) {
    try {
        // 1. VALIDAÇÕES BÁSICAS
        if (!id) {
            console.error("Erro: ID do cabo não fornecido");
            showNotification("Erro: Cabo inválido", "error");
            return false;
        }

        // 2. BUSCAR CABO NO MANAGER
        var cable = cableManager.cables.find(c => c.id === id);
        if (!cable) {
            console.error("Erro: Cabo não encontrado para o ID " + id);
            showNotification("Erro: Cabo não encontrado", "error");
            return false;
        }

        // 2.5. BLOQUEAR ABERTURA DO MODAL PARA CABOS NÃO-RF (UMPT, GPS, DCDU)
        if (cable.sourceType !== 'LOCAL' && cable.sourceType !== 'REMOTE') {
            console.log("ℹ Cabo não é RF (tipo: " + cable.sourceType + "). Modal não necessário.");
            return false;
        }

        // 3. SALVAR REFERÊNCIA ATIVA
        cableManager.activeCableId = id;
        console.log("✓ Abrindo config de cabo: " + cable.sourceType + " (ID: " + id + ")");

        // 4. OBTER ELEMENTOS DO MODAL
        var modal = document.getElementById('cableConfigModal');
        var infoEl = document.getElementById('infoSourceType');
        var oduOpts = document.getElementById('configODUOptions');
        var btnSalvar = document.getElementById('btnSalvarCabo');
        var btnDeletar = document.getElementById('btnDeletarCabo');

        if (!modal) {
            console.error("Erro: cableConfigModal não encontrado no DOM");
            showNotification("Erro: Modal indisponível", "error");
            return false;
        }
        
        if (!infoEl || !oduOpts || !btnSalvar || !btnDeletar) {
            console.error("Erro: Elementos do modal incompletos", {
                infoEl: !!infoEl,
                oduOpts: !!oduOpts,
                btnSalvar: !!btnSalvar,
                btnDeletar: !!btnDeletar
            });
            showNotification("Erro: Interface do modal incompleta", "error");
            return false;
        }

        // 5. ATUALIZAR TIPO DE CABO
        infoEl.innerText = "TIPO: " + cable.sourceType;

        // 6. CONFIGURAR OPÇÕES CONFORME TIPO
        if (cable.sourceType === 'LOCAL' || cable.sourceType === 'REMOTE') {
            oduOpts.style.display = 'block';
            document.getElementById('cfgSetor').value = cable.config.sector || "";
            document.getElementById('cfgRadio').value = cable.config.radio || "64TR Huawei";
            document.getElementById('cfgLteCount').value = (cable.config.lteCount !== undefined) ? cable.config.lteCount : "1";
            document.getElementById('cfgNrBw').value = (cable.config.nrBw !== undefined) ? cable.config.nrBw : "50";
        } else {
            oduOpts.style.display = 'none';
        }

        // 7. CONFIGURAR BOTÕES CONFORME TIPO
        if (cable.sourceType === 'JUMPER' || cable.sourceType === 'GPS' || cable.sourceType === 'ENERGY') {
            btnSalvar.style.display = 'none';
            btnDeletar.style.width = '100%';
            btnDeletar.classList.remove('btn-icon-only');
            btnDeletar.innerHTML = '<span class="material-icons" style="font-size:14px; margin-right:6px;">delete</span> EXCLUIR CABO';
        } else {
            btnSalvar.style.display = 'flex';
            btnDeletar.style.width = '45px';
            btnDeletar.classList.add('btn-icon-only');
            btnDeletar.innerHTML = '<span class="material-icons">delete</span>';
        }

        // 8. POSICIONAR MODAL NO CENTRO DA TELA (FIXO) - SEM DEPENDÊNCIA DE MOUSE
        modal.style.position = 'fixed';
        modal.style.top = '50%';
        modal.style.left = '50%';
        modal.style.transform = 'translate(-50%, -50%)';
        modal.style.zIndex = '10000';
        modal.style.display = 'block';

        console.log("✓ Modal de configuração exibido com sucesso");
        return true;

    } catch (error) {
        console.error("Erro CRÍTICO ao abrir configuração de cabo:", error);
        console.error("Stack:", error.stack);
        showNotification("Erro inesperado ao configurar cabo: " + error.message, "error");
        return false;
    }
}

function aplicarConfigCabo() { 
    var cable = cableManager.cables.find(c => c.id === cableManager.activeCableId);
    
    if (cable && (cable.sourceType === 'LOCAL' || cable.sourceType === 'REMOTE')) { 
        var setor = document.getElementById('cfgSetor').value;
        if (setor === "") {
            showNotification("Por favor, selecione um Setor (A, B ou C).", "warning");
            return; 
        }
        cable.config.sector = document.getElementById('cfgSetor').value;
        cable.config.radio = document.getElementById('cfgRadio').value;
        cable.config.lteCount = parseInt(document.getElementById('cfgLteCount').value);
        cable.config.nrBw = parseInt(document.getElementById('cfgNrBw').value);
    } 
    document.getElementById('cableConfigModal').style.display = 'none';
    cableManager.activeCableId = null; 
    validarCapacidadeBBU(); 
    cableManager.render();
}

function deletarCaboAtivo() { 
    if(cableManager.activeCableId) { 
        cableManager.cables = cableManager.cables.filter(c => c.id !== cableManager.activeCableId);
        cableManager.activeCableId = null; 
        document.getElementById('cableConfigModal').style.display = 'none'; 
        validarCapacidadeBBU(); 
        cableManager.render(); 
        atualizarContadoresGeral(); 
        verificarEstadoSimulador(); 
        manageSystemHealth();
    } 
}


// --- VALIDAÇÃO DE COMPATIBILIDADE DE RADIOS COM PLACAS ---
function validarCompatibilidadeRadios() {
    document.querySelectorAll('.bbu-slot').forEach(s => s.classList.remove('slot-incompatible-radio'));

    var parent = {};
    for(var i=0; i<=19; i++) parent[i] = i;

    function find(i) {
        if (parent[i] === i) return i;
        return parent[i] = find(parent[i]);
    }
    function union(i, j) {
        var rootI = find(i);
        var rootJ = find(j);
        if (rootI !== rootJ) parent[rootI] = rootJ;
    }

    // Agrupar slots conectados por Jumpers
    cableManager.cables.forEach(function(c) {
        if (c.sourceType === 'JUMPER' && c.connectedToStart && c.connectedTo) {
            var s1Match = c.connectedToStart.match(/Slot (\d+)/);
            var s2Match = c.connectedTo.match(/Slot (\d+)/);
            if (s1Match && s2Match) {
                union(parseInt(s1Match[1]), parseInt(s2Match[1]));
            }
        }
    });

    var groups = {};
    for(var i=0; i<=19; i++) {
        var p = find(i);
        if (!groups[p]) groups[p] = [];
        groups[p].push(i);
    }

    // Validar compatibilidade por grupo
    Object.values(groups).forEach(function(groupSlots) {
        var activeSlots = groupSlots.filter(sid => {
            var el = document.getElementById('bbuSlot'+sid);
            return el && !el.classList.contains('bbu-slot-empty');
        });

        if (activeSlots.length === 0) return;

        var activeElements = [];
        var boardInfo = [];
        var radioTypesInGroup = { "64TR": 0, "8TR": 0, "4TR": 0 };
        var radioList = [];

        // Coletar informações de placas
        activeSlots.forEach(function(slotId) {
            var slotEl = document.getElementById('bbuSlot' + slotId);
            activeElements.push(slotEl);
            var label = slotEl.querySelector('.installed-board-label');
            var name = label ? label.innerText : "";
            boardInfo.push({
                slotId: slotId,
                fullName: name,
                model: name.match(/UBBPg(\d+[A-C]?)/)?.[0] || "",
                mode: name.includes("(TN)") ? "TN" : (name.includes("(LTE)") ? "LTE" : (name.includes("(NR)") ? "NR" : ""))
            });
        });

        // Coletar tipos de radios conectados a este grupo
        cableManager.cables.forEach(function(c) {
            if (!c.connectedTo || (c.sourceType !== 'LOCAL' && c.sourceType !== 'REMOTE')) return;
            
            var match = c.connectedTo.match(/Slot (\d+)/);
            if (match) {
                var slotId = parseInt(match[1]);
                if (activeSlots.includes(slotId)) {
                    var radioType = c.config.radio || "64TR Huawei";
                    radioList.push(radioType);
                    if (radioType.includes("64TR")) radioTypesInGroup["64TR"]++;
                    else if (radioType.includes("8TR")) radioTypesInGroup["8TR"]++;
                    else if (radioType.includes("4TR")) radioTypesInGroup["4TR"]++;
                }
            }
        });

        // Se não há radios conectados, não há conflito
        if (radioList.length === 0) return;

        var issues = [];

        // --- VALIDAÇÃO 1: G3B (Apenas MIMO - 64TR) ---
        boardInfo.forEach(function(board) {
            if (board.model.includes("UBBPg3B")) {
                if (radioTypesInGroup["8TR"] > 0 || radioTypesInGroup["4TR"] > 0) {
                    issues.push(`G3B aceita apenas 64TR (MIMO). Encontrado: ${radioTypesInGroup["8TR"]}×8TR + ${radioTypesInGroup["4TR"]}×4TR`);
                }
            }
        });

        // --- VALIDAÇÃO 2: G2C (Apenas STD - 8TR, 4TR. SEM 64TR) ---
        boardInfo.forEach(function(board) {
            if (board.model.includes("UBBPg2C")) {
                if (radioTypesInGroup["64TR"] > 0) {
                    issues.push(`G2C não aceita 64TR (MIMO). Aceita apenas 8TR e 4TR. Encontrado: ${radioTypesInGroup["64TR"]}×64TR`);
                }
            }
        });

        // --- VALIDAÇÃO 3: G2A em TN (Bloqueia MIMO) ---
        boardInfo.forEach(function(board) {
            if (board.model.includes("UBBPg2A") && board.mode === "TN") {
                if (radioTypesInGroup["64TR"] > 0) {
                    issues.push(`G2A no modo TN não aceita 64TR. Aceita apenas 8TR e 4TR. Encontrado: ${radioTypesInGroup["64TR"]}×64TR`);
                }
            }
        });

        // --- VALIDAÇÃO 4: G3A em TN (Não aceita 8TR + 4TR juntos) ---
        boardInfo.forEach(function(board) {
            if (board.model.includes("UBBPg3A") && board.mode === "TN") {
                if (radioTypesInGroup["8TR"] > 0 && radioTypesInGroup["4TR"] > 0) {
                    issues.push(`G3A (TN) não aceita 8TR + 4TR juntos. Encontrado: ${radioTypesInGroup["8TR"]}×8TR + ${radioTypesInGroup["4TR"]}×4TR`);
                }
            }
        });

        // Se houver problemas, mostrar e marcar slots
        if (issues.length > 0) {
            activeElements.forEach(el => el.classList.add('slot-incompatible-radio'));
            if (typeof courseState !== 'undefined' && !courseState.active) {
                var context = (activeElements.length > 1) ? "GRUPO (Jumper)" : activeElements[0].querySelector('.installed-board-label').innerText;
                showNotification(`INCOMPATIBILIDADE ${context}: ${issues[0]}`, "error");
            }
            return;
        }
    });
}

function validarCapacidadeBBU() {
    document.querySelectorAll('.bbu-slot').forEach(s => s.classList.remove('slot-overload'));

    // Validar compatibilidade de radios ANTES de validar capacidade
    validarCompatibilidadeRadios();

    var parent = {};
    for(var i=0; i<=19; i++) parent[i] = i;

    function find(i) {
        if (parent[i] === i) return i;
        return parent[i] = find(parent[i]);
    }
    function union(i, j) {
        var rootI = find(i);
        var rootJ = find(j);
        if (rootI !== rootJ) parent[rootI] = rootJ;
    }

    cableManager.cables.forEach(function(c) {
        if (c.sourceType === 'JUMPER' && c.connectedToStart && c.connectedTo) {
            var s1Match = c.connectedToStart.match(/Slot (\d+)/);
            var s2Match = c.connectedTo.match(/Slot (\d+)/);
            if (s1Match && s2Match) {
                union(parseInt(s1Match[1]), parseInt(s2Match[1]));
            }
        }
    });

    var groups = {};
    for(var i=0; i<=19; i++) {
        var p = find(i);
        if (!groups[p]) groups[p] = [];
        groups[p].push(i);
    }

    // --- NOVA LÓGICA: Soma Global de Portadoras (independente de tipo de rádio) ---
    var slotDemand = {};
    cableManager.cables.forEach(function(c) {
        if (!c.connectedTo || (c.sourceType !== 'LOCAL' && c.sourceType !== 'REMOTE')) return;
        
        var match = c.connectedTo.match(/Slot (\d+)/);
        if (match) {
            var slotId = parseInt(match[1]);
            if (!slotDemand[slotId]) slotDemand[slotId] = { total_lte: 0, total_nr: 0 };
            
            var lteCount = parseInt(c.config.lteCount) || 0;
            var nrBw = parseInt(c.config.nrBw) || 0;
            
            // Soma GLOBAL: todas as portadoras LTE e NR, independente de 64TR, 8TR ou 4TR
            if (lteCount > 0) slotDemand[slotId].total_lte += lteCount;
            if (nrBw > 0)     slotDemand[slotId].total_nr += 1;
        }
    });

    Object.values(groups).forEach(function(groupSlots) {
        var activeSlots = groupSlots.filter(sid => {
            var el = document.getElementById('bbuSlot'+sid);
            return el && !el.classList.contains('bbu-slot-empty');
        });

        if (activeSlots.length === 0) return;

        var groupCapLTE = 0;  // Capacidade Global LTE
        var groupCapNR = 0;   // Capacidade Global NR
        var groupUseLTE = 0;  // Uso Global LTE
        var groupUseNR = 0;   // Uso Global NR
        var activeElements = [];

        activeSlots.forEach(function(slotId) {
            var slotEl = document.getElementById('bbuSlot' + slotId);
            activeElements.push(slotEl);
            var label = slotEl.querySelector('.installed-board-label');
            var name = label ? label.innerText : "";

            // Soma uso global por slot
            if (slotDemand[slotId]) {
                groupUseLTE += slotDemand[slotId].total_lte;
                groupUseNR  += slotDemand[slotId].total_nr;
            }

            var isTN = name.includes("(TN)");
            var isNR = name.includes("(NR)");
            var isLTE = name.includes("(LTE)");
            
            // Extrai modelo da placa (remover modo)
            var modelMatch = name.match(/UBBPg(\d+[A-C]?)/);
            var model = modelMatch ? modelMatch[0] : "";
            
            if (model.includes("UBBPg3A")) {
                if (isTN) { groupCapLTE += 6; groupCapNR += 3; }
                else if (isNR) { groupCapNR += 6; }
                else if (isLTE) { groupCapLTE += 6; }
            }
            else if (model.includes("UBBPg3B")) {
                if (isTN) { groupCapLTE += 3; groupCapNR += 3; }
                else if (isNR) { groupCapNR += 6; }
                else if (isLTE) { groupCapLTE += 6; }
            }
            else if (model.includes("UBBPg2A")) {
                if (isTN) { groupCapLTE += 6; groupCapNR += 3; } 
                else if (isNR) { groupCapNR += 6; } 
                else if (isLTE) { groupCapLTE += 6; }
            }
            else if (model.includes("UBBPg2C")) {
                if (isTN) { groupCapLTE += 6; groupCapNR += 3; }
                else if (isNR) { groupCapNR += 3; }
                else if (isLTE) { groupCapLTE += 6; }
            }
            else if (model.includes("UBBPg1a")) {
                groupCapLTE += 3;
                groupCapNR += 0;
            }
        });

        var issues = [];
        if (groupUseLTE > groupCapLTE) issues.push(`Falta capacidade em LTE: ${groupUseLTE} > ${groupCapLTE}`);
        if (groupUseNR > groupCapNR) issues.push(`Falta capacidade em NR: ${groupUseNR} > ${groupCapNR}`);

        if (issues.length > 0) {
            activeElements.forEach(el => el.classList.add('slot-overload'));
            if (typeof courseState !== 'undefined' && !courseState.active) {
                var context = (activeElements.length > 1) ? "GRUPO (Jumper)" : activeElements[0].querySelector('.installed-board-label').innerText;
                showNotification(`ALERTA ${context}: ${issues[0]}`, "error");
            }
        }
    });
}

function atualizarPowerBudget() {
    var currentCapacity = 0;
    
    [18, 19].forEach(function(sid) {
        var slot = document.getElementById('bbuSlot' + sid);
        if (slot && !slot.classList.contains('bbu-slot-empty')) {
            var labelEl = slot.querySelector('.installed-board-label');
            if(labelEl) {
                var label = labelEl.innerText;
                var specs = getUpeuSpecs(label);
                var cable = cableManager.cables.find(c => c.connectedTo === "Slot " + sid + " Port PWR");
                if (cable && dcduSwitches[sid]) {
                    currentCapacity += specs.capacity;
                }
            }
        }
    });
    
    var currentLoad = POWER_SPECS.FAN; 
    for(var i=0; i<=7; i++) {
        var slot = document.getElementById('bbuSlot'+i);
        if(slot && !slot.classList.contains('bbu-slot-empty') && !slot.classList.contains('slot-dummy')) {
            if(i <= 5) currentLoad += POWER_SPECS.UBBP; 
            else currentLoad += POWER_SPECS.UMPT;       
        }
    }
    
    var textEl = document.getElementById('pTextVal');
    var barEl = document.getElementById('pBarFill');
    if(textEl) textEl.innerText = currentLoad + "W / " + currentCapacity + "W";
    
    var percent = 0;
    if (currentCapacity > 0) percent = (currentLoad / currentCapacity) * 100; 
    else if (currentLoad > 0) percent = 100;
    
    if(barEl) { 
        barEl.style.width = Math.min(percent, 100) + "%"; 
        if (currentLoad > currentCapacity) barEl.style.backgroundColor = '#e74c3c'; 
        else barEl.style.backgroundColor = (percent >= 90) ? '#f1c40f' : '#2ecc71'; 
    }
    
    return { load: currentLoad, capacity: currentCapacity, overloaded: (currentLoad > currentCapacity) };
}

function isChassisPowered() { 
    return (atualizarPowerBudget().capacity > 0);
}
function limparSimulacao(resetarCurso) {
    // --- NOVO BLOCO: RESET DO CONSOLE E LÓGICA ---
    
    // 1. Reseta o visual do terminal (Mantém o cabeçalho padrão)
    var consoleOut = document.getElementById('consoleOutput');
    if(consoleOut) {
        consoleOut.innerHTML = `
            <div class="console-line header-msg">Huawei MML Command Interface</div>
            <div class="console-line">Version: V100R019C10SPC100 (LTS)</div>
            <div class="console-line">Copyright (c) Huawei Technologies Co., Ltd.</div>
            <br>
            <div class="console-line success-msg">System initialized. Connection secure.</div>
            <br>
        `;
    }

    // 2. Limpa o histórico de comandos (Seta p/ cima)
    if(typeof terminalHistory !== 'undefined') {
        terminalHistory = [];
        historyPointer = -1;
    }

    // 3. Reseta a configuração de IP (Obriga a fazer SET DEVIP de novo)
    if(typeof transmissionState !== 'undefined') {
        transmissionState = {
            ip: "0.0.0.0",
            mask: "0.0.0.0",
            gateway: "0.0.0.0",
            isConfigured: false
        };
    }
    if (typeof resetarCurso === 'undefined') resetarCurso = false;
    if (resetarCurso === true) {
        courseState.currentIdx = 0;
        courseState.completedModules = [];
        courseState.isTheoryRead = false;
        loadModule(0);
        showNotification("Simulação e Curso reiniciados!", "success");
    } else {
        if(!courseState.active) showNotification("Ambiente limpo e reorganizado.", "success");
    }

    // Limpeza via Manager
    cableManager.clearCables();
    cableManager.activeCableId = null;
    
    activeFaults = {};
    polyConnections = [];
    dcduSwitches = { 18: false, 19: false };
    umptStates = { 6: 'OFF', 7: 'OFF' };
    var dcduBox = document.getElementById('dcduBox');
    if (dcduBox) {
        dcduBox.style.display = 'none';
        document.getElementById('sw18').classList.remove('on');
        document.getElementById('sw19').classList.remove('on');
    }

    document.querySelectorAll('[id^="oduDynamic_"]').forEach(el => el.remove());

    // --- RESET DA PILHA ---
    var boxRemote = document.getElementById('oduRemote');
    // Se o remoto estiver visível, o nível base é 1. Se não, é 0.
    if (boxRemote && boxRemote.style.display !== 'none') {
        siteStackLevel = 1;
    } else {
        siteStackLevel = 0;
    }
    document.querySelectorAll('.draggable-sfp, .draggable-dummy, .draggable-usb, .ue-dot').forEach(el => el.remove());
    document.querySelectorAll('.usb-stick-inserted').forEach(el => el.remove());
    document.querySelectorAll('.bbu-slot').forEach(s => s.classList.remove('slot-overload'));
    if(ueInterval) clearInterval(ueInterval);
    
    var grid = document.getElementById('bbuGrid');
    if(grid) grid.classList.remove('bbu-glow-on', 'bbu-flash-error');
    
    // RESET TOTAL DOS SLOTS
    document.querySelectorAll('.bbu-slot').forEach(function(slot) {
        slot.classList.remove('slot-burnt', 'slot-dummy', 'slot-overheat', 'drag-over');
        slot.style.boxShadow = 'none';
        slot.removeAttribute('title');
        
        var slotId = slot.getAttribute('data-slot');
        // Remover elementos internos
        while (slot.firstChild) { slot.removeChild(slot.firstChild); }

        var isFan = slot.classList.contains('fan-slot');
        if (isFan) {
            slot.classList.remove('fan-broken');
            slot.innerText = "FAN";
        } else {
            // Cria o label padrão do slot
            var span = document.createElement('span');
            span.className = "slot-id-label";
            span.innerText = "SLOT " + slotId;
            slot.appendChild(span);
            
            // Define comportamento baseado no ID
            if (slotId === '18' || slotId === '19') {
                slot.className = 'bbu-slot bbu-slot-empty';
                slot.setAttribute('data-accept', 'UPEU');
                // Estilo visual ligeiramente diferente para indicar área de energia
                slot.querySelector('.slot-id-label').style.color = '#e74c3c';
            } else if (slotId === '6' || slotId === '7') {
                slot.className = 'bbu-slot bbu-slot-empty';
                slot.setAttribute('data-accept', 'UMPT');
                slot.querySelector('.slot-id-label').style.color = '#f37021';
            } else {
                slot.className = 'bbu-slot bbu-slot-empty';
                slot.setAttribute('data-accept', 'UBBP');
            }
        }
    });

    hardResetBox('oduLocal'); hardResetBox('oduRemote'); hardResetBox('umptBox');
    hardResetBox('gpsBox'); hardResetBox('partsBox');
    
    for (var key in bootTimers) { 
        if (bootTimers[key]) { clearTimeout(bootTimers[key]);
        bootTimers[key] = null; } 
    }
    
    cableManager.render(); 
    atualizarContadoresGeral(); 
    atualizarPowerBudget(); 
    manageSystemHealth();
  }

  function hardResetBox(elementId) {
      var el = document.getElementById(elementId);
      if (el) { el.style.removeProperty('top'); el.style.removeProperty('left'); el.style.removeProperty('transform');
      }
  }

function verificarEstadoSimulador() {
    var dcduBox = document.getElementById('dcduBox');
    var chassis = document.getElementById('bbuGrid');

    var s18 = document.getElementById('bbuSlot18');
    var s19 = document.getElementById('bbuSlot19');
    var temUPEU = false;

    if (s18 && !s18.classList.contains('bbu-slot-empty') && !s18.classList.contains('slot-dummy')) temUPEU = true;
    if (s19 && !s19.classList.contains('bbu-slot-empty') && !s19.classList.contains('slot-dummy')) temUPEU = true;

    var umptCorreta = cableManager.cables.some(c => c.sourceType === 'UMPT' && c.connectedTo && (c.connectedTo.includes("Slot 6") || c.connectedTo.includes("Slot 7")));
    
    if (temUPEU || umptCorreta) {
        dcduBox.style.display = 'flex';
    } else {
        dcduBox.style.display = 'none';
    }
    
    if (dcduBox.style.display !== 'none' && isChassisPowered()) {
        chassis.classList.add('bbu-glow-on');
    } else {
        chassis.classList.remove('bbu-glow-on');
    }
}
// =========================================================
// BBU ARCHITECT SIMULATOR - SCRIPT.JS (Parte 5-2-A)
// =========================================================

// --- 9. DEPLOY E RELATÓRIOS ---

function validarAntesDoDeploy() {
    var erros = [];

    // 1. Verificações Físicas
    for (var i = 0; i <= 7; i++) { 
        var slot = document.getElementById('bbuSlot' + i);
        if (slot && slot.classList.contains('bbu-slot-empty')) erros.push("Slot " + i + " está aberto! Instale Placa ou Tampa.");
    }
    if(document.getElementById('bbuSlot18').classList.contains('bbu-slot-empty')) erros.push("Slot 18 aberto. Instale UPEU ou Tampa.");
    if(document.getElementById('bbuSlot19').classList.contains('bbu-slot-empty')) erros.push("Slot 19 aberto. Instale UPEU ou Tampa.");

    var gpsConectado = cableManager.cables.some(c => c.sourceType === 'GPS' && c.connectedTo);
    if (!gpsConectado) erros.push("Falta conexão do GPS.");
    
    // Verificação de Energia
    var pData = atualizarPowerBudget();
    if (pData.capacity === 0) erros.push("BBU sem alimentação (0 Watts).");
    if (pData.overloaded) erros.push("SOBRECARGA DE ENERGIA: Consumo > Capacidade da UPEU.");

    // 2. Validação Lógica (IP / Transmissão)
    var temCaboTransmissao = cableManager.cables.some(c => c.connectedTo && c.connectedTo.includes("Slot 7") && (c.sourceType === 'UMPT' || c.connectedTo.includes("XGE")));
    
    if (!temCaboTransmissao) {
        erros.push("Falta cabo de transmissão (Backhaul) na UMPT.");
    } 
    else if (transmissionState.isConfigured === false) {
        erros.push("Falta configuração lógica (IP). Use o Console: SET DEVIP.");
    }

    // 3. Validações de Rádio
    var cabosSite = cableManager.cables.filter(c => c.sourceType === 'LOCAL' || c.sourceType === 'REMOTE');
    if (cabosSite.length === 0) {
        erros.push("Nenhum site conectado.");
    } else {
        cabosSite.forEach(function(c) {
            if (!c.config.sector || c.config.sector === "") {
                c.config.sector = "A"; 
                c.config.radio = c.config.radio || "64TR Huawei";
                setTimeout(() => cableManager.render(), 100); 
            }
        });
    }
    
    if(document.querySelector('.slot-overload')) erros.push("Erro de Hardware: Placa sobrecarregada.");
    
    return erros;
}

function runDeploySequence() { 
    var listaErros = validarAntesDoDeploy();
    if (listaErros.length > 0) { 
        showNotification("BLOQUEADO: " + listaErros[0], "error"); 
        var grid = document.getElementById('bbuGrid'); 
        grid.classList.add('bbu-flash-error'); 
        setTimeout(() => grid.classList.remove('bbu-flash-error'), 1000); 
        return;
    }
    
    var pData = atualizarPowerBudget(); 
    var cargaPercentual = (pData.capacity > 0) ? (pData.load / pData.capacity) : 0;
    if (cargaPercentual >= 0.9) showNotification("ALERTA: Carga Alta (" + Math.round(cargaPercentual * 100) + "%).", "warning");
    
    var overlay = document.getElementById('deployAnimationOverlay'); 
    overlay.style.display = 'flex'; 
    var txt = document.getElementById('animStatusText'); 
    var stage1 = document.getElementById('stageAssembly'); 
    var stage2 = document.getElementById('stageTower');
    var bbuAnim = document.getElementById('animBBU');
    
    txt.innerText = "INITIALIZING DEPLOYMENT..."; 
    stage1.classList.remove('active'); 
    stage2.classList.remove('active'); 
    bbuAnim.classList.remove('mounted'); 
    
    if(ueInterval) clearInterval(ueInterval); 
    document.querySelectorAll('.ue-dot').forEach(e => e.remove());
    
    setTimeout(() => { 
        stage1.classList.add('active'); 
        txt.innerText = "MOUNTING BBU CHASSIS..."; 
        setTimeout(() => { 
            bbuAnim.classList.add('mounted'); 
            setTimeout(() => { 
                stage1.classList.remove('active'); 
                stage2.classList.add('active'); 
                txt.innerText = "UPLOADING CONFIG TO TOWER..."; 
                setTimeout(() => { 
                    txt.innerText = "BROADCASTING SIGNAL - 5G SA"; 
                    startUESimulation(); 
                }, 2000); 
            }, 2500); 
        }, 500); 
    }, 100);
}

function startUESimulation() { 
    var scene = document.getElementById('towerScene'); 
    var counter = 0;
    ueInterval = setInterval(() => { 
        if(counter > 15) return; 
        var dot = document.createElement('div'); 
        dot.className = 'ue-dot'; 
        var rLeft = Math.floor(Math.random() * 90) + 5; 
        var rBottom = Math.floor(Math.random() * 80) + 10; 
        dot.style.left = rLeft + '%'; 
        dot.style.bottom = rBottom + 'px'; 
        scene.appendChild(dot); 
        setTimeout(() => { dot.classList.add('connected'); }, 1500); 
        counter++; 
    }, 800);
}

function closeDeployAnim() { 
    document.getElementById('deployAnimationOverlay').style.display = 'none'; 
    if(ueInterval) clearInterval(ueInterval); 
}

function baixarPDFSimulacao() { 
    document.getElementById('inDesignerName').value = ""; 
    document.getElementById('inCityState').value = ""; 
    document.getElementById('pdfInfoModal').style.display = 'flex'; 
    document.getElementById('inDesignerName').focus();
}

async function gerarPDFFinal() {
    var designer = document.getElementById('inDesignerName').value || "TÉCNICO RESPONSÁVEL";
    var city = document.getElementById('inCityState').value || "BRASIL";
    document.getElementById('pdfInfoModal').style.display = 'none'; 
    var btn = document.querySelector('.btn-pdf'); 
    var oldText = btn.innerHTML;
    btn.innerHTML = '<span class="material-icons" style="font-size:16px; animation:spin 1s infinite linear">refresh</span> PROCESSANDO...';
    
    if (!window.jspdf) { 
        showNotification("Erro: Libs PDF não carregadas.", "error");
        btn.innerHTML = oldText; return; 
    }

    try {
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF('l', 'mm', 'a4'); 
        const el = document.getElementById('simContainer');
        
        // --- COLOQUE SUA BASE64 AQUI ---
        const logoUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAVkAAADCCAYAAADjJLHvAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwaADsQAAA7EAZUrDhsAAGABSURBVHhe7Z13eBVF98e/Z9NIJyEkkIQEQkLvvQQpCggi6KsvUuxgwa6gYg15FQVEUUAFBcS GXQEbgnQQqaG3hBZSgPTeZ35/zN27e/fWhID+dD7Pc59778zs7Mzs7tmzZ8+cofHjx3JIJBKJ5IqgGBMkEolEUn9IISuRSCRXEClkJRKJ5Aqi+Pr6GdMkEolEUk/QlCkP8Pz8PH0SAIBz7X1Yw4YNERfXCk2aNEFpaemWEyeOb2FM5CkOdGHGtHz1t34 79bf631hOn2YsZ0zXY6tN9uqDjfL6svo02CjrCFt9NbbBVn3GMTB+68sYfzv7b8zTp9nKcyUfdvbhqI8qtupUt4OT88TW f1tp9up3VM7YZ30ZY5oefb4RW+n26nXUFiPG9tgrq0+zla/iLA+GsTP+NpaxhVoGLh4He//12NpeTXdUh7HdsNE/9bt9+w 7X+Pj4XJObm4Pk5GRkZmZayEoVIoBz8U1TpjzA8/I0IatmAoCnpyeuv34EBg8esiUsLCxRUZQNWjUSiUTy7yUnJ+fVQ4cO vvDVV18hLy8XMMlPQJOh0GuyaiKZSnl5eWHChIlbhw0bfg1jpQNQuGEG1RQOAS/TtpZIJJJ/HW6ARxNwr04vKg3CZ6ampm 55++23BmRmZlgKV1Wb1cwFBEAtQbjjjjsxcuQNxEpPPE+Fq2bCpye4V9xr8AjboCge67WqJBKJ5N8Dq8qZiYoTA6h4+wDu02e9EjDguqSkpC0LF84fUFpaAoAsTAgG6wWBcyAqKhp9+/ZLZIUHBlDh6pk88NbXKWAwKV6RL0gBK5FI/s0oHo1eUPz6X cMbPXgdVRy7lhX/+XvXrl2viY+PN5XgZosAEUHRBC43ZQLR0dHbgoKCZlDVgS3cf/g2xTvmebWURCKRSADFw389bzjkOirZeS3nlfHNm8ckCnmqWQU451BUQ61A/AkMDFjPWGUCagpBPm0T9SUkEolEIlA8Ytdz8tiG4h3X9ejRA97eDcwCVpWtCizeh IkfPj5+oJoC4tXZ24g8fldzJRKJRGIJeXdej9yvoSgKPD29jNmWNlnOVd8u4rwimaM6VwpYiUQicQB38+WcajgRcb0LrIqFkCVSP5yIcyLysDAmSCQSicQS4kJecs5JnYCgKqxQhSyR8CpQbbISiUQiqR3MNGVMm3Mgvk02We1NmNlcYPqoFUgkEonE GlVWurm5CVXVZBFQ0ZkLNL+umhpOxGuIOJeqrUQikThAVUlramoIxim1RJqQ1Sutbm7EOblJTVYikUicYNRkBQR15pdZyGoGWylXJRKJpLaoNlkx24ubJ3eZX3xpL78AbrbISnOBRCKROML8BkudS2vCwrsA4GYN1lBOIpFIJLVAk6VC0JqELFm8DZNI JBJJ3VBlqWqCtXDhssBG1HeJRCKROEbvJ6vTZGHSZnVxEA1BECUSiURSe8wvvgx2WWHK5dKFSyKRSByhugmQyeVVyFN13oEjcwGkNiuRSCS1R7hvmY0CmtuW3mArXbgkEonEFWzN+FLlKecQQbs1ty0pUyUSiaQuKKZ1xNV5B+Z08aWaC8QMBRkgRiK RSFzDaJNVzQXQ22RVP1lVzZXmAolEInENVVZyC3kpfppcuCyNtHLGl0QikdQey3iyuhdfejuskK9cmAtMgb7NmRKJRCKxQn3u1+LJau5bBnOBpt5yblquhqS5QCKRSBxhbS4QuqnQZE3xZLWVEbQN5bRaiUQiqSvqey5TPFn1j/obkBMRJBKJpK4IeSo sBCZNVmRYvPOSmqxEIpHUClWGqu+3oMUuUI21WuBuqclKJBJJ7dBMrqrGajIXqC4HML0ZE5MRhLesuolEIpFIrOEmbyx1 MoLJecDyxZeuOEzRuEzOBdK7QCKRSBxBJm8s/WQEoaxC02RNyeaPnFYrkUgkrmE9rRZmywAs48mqGaomy4lqpCYrkUgkjj D6yQpxqr3f0vnJatPAzMiXXxKJRHJZmMWolYCVSCQSSa1RHQlUA4GFC5eFn6xEIpFIao1ejnJ1IUWjy4FEIpFIao8mYDU5atZkbSJnfUkkEkkdUOcd6DRZcxY3hTqULlwSiUTiFL0Ll7AKWOZb+A8I26zpDzPmSiQSicQmuqd+S8sAwbQygobJPiviyc oZXxKJROIQ/Ywv0i3jJeyyHIoa91CVviZPA7EygjQXSCQSiUOM5gJtAQQhPnXeBaYNVLEqTQUSiURSB9SXXmLWl4Uo1QStKpuluUAikUgcYZxWq734EhMSzEJWTkaQSCSS+kc3rVYzv0qbrEQikbgGN8lLfRQuobDaMBeoSO8CiUQicQ29dwF0AlaYC 5wBu00eBVZOtBKJRCK5HAzLz1hMRpBIJBJJnVBjwRjMBQbpyv7awAWsuGAF27SymO3eWMxyMjsY8680jLEOLOVwMfv5c93nM9Pn82L2y4pidnL/CuN2/xZYzqXx7NjeYrbuGzEef6wpZudPrWCMXfVjJZH8HWA6mWkx92DKlAd4Xl6eToMljBs3LnH0k FAg/3tQszdnmLe8ivBNqzkWTAcUBfy6/1bi5kl3KaGRXxrLXSl4UcEMvDgxAakpxiwBAejcH5Sw9F+n+7Pj+1fQN++Ox6 E/geoq4RaoKEBQCPhNkyvRd2h3pVHTw8btJJJ/IrwkaQayF6E05C089dQTCQUFBaYJCRw2FlIkCy+Dv5SLqQCrAaqrQL99 4Ukf/O8Llnnuc2OxKwarBkqLTQNl48M5UFxo3OofDzux/3N6e+p47NsCVFWabE1cHKucS6CPZnli9cd7WUWF1Ggl/x4MsQ u00LFWkxH+JgIWAMpLtd+cA3u3gOZNm8CO7r16gtaZgdpJ9j8NVln+HH3/4QRcTDNmmRDCln75zBP7NicYcyWSfyw2/bQEVlG4xPffINRhUb4hgQPJB0ELpk9g+7Z+Zsisd/7Svv9dObzLE3s2GlOtqa4C7dl0qzFZIvknoo9doKbpJ3eZXbiEEitS/ +pptay6+jkUFRiTRfsupII+mDGR7fjtigrav6rvf2do/XcEVmNMts2Zo2Clxc8ZkyWSfxq2p9UKeyz0AWLEt7b411+Kory FwTcBDXwMGaaGXkwDLXt9Ivtz3aeGAvXHX+tc8ffEbMJx4SSpqQbV1HgZkyWSKw0rzG7Hfv28gH38RgH7xNZnbgE7ts+WFlcvaEqrkFdmTVb/Dfy1QkZRlAreq2sgH/foUXh4GrMF2ZmgJa/ezvZs+sSYVb+QfaHybzMo9BhkOklc6HhYFLiv/+vGZIn kSkOnjs2gT+YG0KqlAbTS1mdJAK3+KIBzPt247eWgd+GCSXnl3GIygvb9d0BRQgpx/bhE3PogoLgZswU5F0Afz7mDnUiqf0GrqLLEwaDYkb3/WOJHAlGtjKk24Z37H1UUpcKYLpFccQpy/ovyMlXK2f5ExoBzPs+46eWgKOIVFzfFlLWyyeq/tZy/Fs XL52t0v74hBo42ZmmknQItTryDZ56r17sSoBeiDgTtvwm/hrP4f6cchbevMceSrgOAwTcnGpMlkisNKy9vhwM7HF+zpACtOqNelQAby8+oSuvfQJRaww7taMsO7foPAFDLlgV8xLi70KqzroRBhTxzDPyTuQksO+M/lhmS+oSIyim8TXc+8aljCGps7e Lm7gH0vBZ80kvfKz4+X1tmSiRXHirKGYsD243Jlvg3BA9qPMuYfFnoJKlqJoC4ZjRzgbpkgsZfaJQ9f3offTLnO55+ZjkAKHFdPsHN982Gb4CpgPVdinaua0C/f/edMV1Sv1CLFuU0cmI3/vKS7zH+caDXtUDnfsB1/ZOYx/vCrdysR0bcYt5NIr gb85xVtkJdlTLYkriOoZYcr9qSlF6Vmm6x4GyZcDjS77F+n5FLqyQZIOQx8Pu8ulnGmLQCg93UzcMdU+/ZZzoEfloDt3pBrzJLUL0RUrjRvcwuGjgzGDeODce29wRg1NpiuGd1NCQz+2FheIrkasJyLz9LhHbcZ043wHkOOEVG5Mf1KYNZkNf56Fy5WW f4sUk8KbXXn78CujXs5522IqBy9rrsHXQcYtlAbTEBlOejjOUHs9NFnDYXqhrXCbGmqsJn/74EaRudRpwF5NGBAHkV3yrtaJ65EYoRz3gabVyXg9DFjliVNokDdB1wVU5aqvJqFrNFY+1dB5095I/O8+MNqQF8t9OZ7NiQAAAWFLMeoO2bD20+3hdpg 03f6WeDHjxN4YWEbXaG6YfOG8xcPkEQisYDz8jb8wPZ99OUCb3AHZk5SgDH3gDdqOtuYVV9oPrKqGdYqdoEt2+zVhZcUPYPCHC2hvAS0avk4fnBPGwDgHfrsx4gJui2McNCONd5859orP3f+rx0qieRfDysvH8N3btlH7zzrjapKY7YlLduB97j2XkVR yoxZ9YUqWDUxqjMXaALWJIYd3BCuJHRsj7dVLNuje8DPH93HGGutuLt/yeNHzUGjJuoWlmUBoKIctP7bcay0+BljlsvUQ /9ZQUFrtmv9aHZgx1J2eFc2S9qWbfpeyrb9OpoV5DrwTft3wRhrzU4fHs1WLhnNju0TY5W0LZsd25vNvntvNNu7bTQrL2h t3O5KwMpLRrO9m0azQzvFcdu3JZvt2yzasnLJaHb68GjG2FVpizPYhbTR7Pi+pezgjmy24zfx2b89mx34Yyk7vGM0Ky+/K u00H7+je5ayQ7uy2Z+/Z7M/fstmuzdks+NJ2ezXT0eztNP1Nm6svKA1O7p7KX02dyXNm+aNfJ1iZguvBuATp55QQsI+Mmb VF9pkBCGThKDloClT7uf5+QU6lwNg7NjxiTddd/XjybLy8tY0467jOLHfmAUEhwGvfppITaNn8PR0H/7LR/vol0/tHzAi8CffLFUG3ODEqdM2PC9nBp65NQHZGcYsjbhOoDnfWEh5VpDVGsVF27FrPfDHWm/KveCDshJT3FUuHlnc3QEvb6BhCHjrLj noOxyIbr1Kadhokr4uV2BnTyxFxpkxNu08iiLqDW9us17GWGtknG0NzpYh54II7ajWQwS0bA80juivKMoJdi55KdJPj3H4 OGaGgKjYVUqzWJv7VWHl5a1x8fwzOH1kDLb97E1pp31QUghUVWhB40kBPDwBbx/who1L0WNwGXoOBoJC71WCG6821llXWF baaORmLcOuDaAjuxohKxMoL9GFczS1xdML8AsEbxZbimtGlaFlx1VoEjZHURqcgOnGigtntiP3kmEPpmvPxx9o2qy/0jjyhJrMLqYvRfaFMZaFdQQ0FMehgW4feRe3Y8P3oP1bGyEvC6gog/nYkAK4ewI+fuCRMaXoN6IMbbutQuPIOWod9QErL2iNC xeewZmjY7B9jTedTxHHr7JcjJn5edkN8Gogxq1521L0GVqGFm1q1R5WXtAamZnbkXMBOJ8C7NviTedO+KC4wDUbp4cn+H1038yG71/Hqw+A9m/rS1npfenUoWYW69jpKcwX+wgMhtIo8ryaTAHByRQWIRYeO7IzgV65rxn9sLQZXUjtS9AlKgMnLzbGqYuNMKTTafx5vBnahadj77kWaOhTgvhWJ3EkLQJpecHmfft4VaJDZBoqa7yx+3QzU2wDTZW1rdVamAu0TtbUSHOBRCJxHeEnq4UN1NspVQGr5YltyBzrQK8JaiYGDoAxBZGNCtAr5gwGtjmKLtHpIFKw73QUBrU9icFtjmBQ6+OoZm7YdDwW3VucBQBENcpBaYUbUi42Rp+4MxjQ+jj6x53EkLbH4ONZjrWHW6NN00tQFA7OCdXMTb0doF/caaw70h4cwOD2YrtBbY+iXcQF7DrVEoQqhPoXmnousOyTFl+W1Gm1+juIaUA458KRS1ePRCKR2ET1dbX0VtIUN72cgUkIi2+tjIV3k9B1AQCBvhU4nN4M6450xpH0pohqlIM9Z6Lg7Q38drgz1h1pj47NMsE5UMM8AADNGhXi4PkI9ItNwbbjLbH+aAesP9oOaw51QIvGWfBvUI6SCgVe7tUAuFkf9fMqR35JA/h6VSI29BLWHmyPDUfb4bdDnXD6Ugh6xZ7FicwwRDfKEtsZFFQhQ7lZw+Vi+Rn1hZcqecVdiUhMSTDtWyKRSOyizfjS9DJVadOjClVLeQOd+cAyxqwopP3MLfbBkbRQlFe5I6vIzyRYCScygtE0MA9FZcIs4O1RBsYVEFXD3Y3Bz6scAd7laOxfDG/PSlTVuIFApkd+bQduCkdeqS+C/Mpx4mKkhRC9UBCAqmoFhWU+IEWTm2o/9Rqs2EZo5VZrfEFGOZRIJLVEUfQCU0MIVJgFmVbG+JBsjBOrV3v1GiKhukYIUpjrJ3AQ3BRmrtZNEcI6LTcEHSNT0alZKtqGpyO8YQG2HG+DGqbA27MK5VXu5n2IL2E+UOtUBSXUmwYDGFdMZbQNtd+Wy+hA79mr3j2MgySRSCSuYin8xG9NqGqCU9X+9NtYCFZTebM4MmfZElDWaao8y8gPxpnsMJzJDkNabiMUlPmgTdMMDG53HJuPx5nLE6n7IIv69HZlURBmYSr+WLqpGeUnVwPE6Dtp/q0EgFcXuplLSyQSiRPsCRuBZgowa6AW5Ywbaf818St+cVXGmX6rNl6VihovgAPxrU7Cw60absRAJGyvyZfCsOZgB5RUeFreCExV+HhWoqICCGxQpGsr4OleA29PBm+PKni4MQvbq6hHf5MQbSK9uUBIY7EBYwAaxID8er6o30gikUjso1PS9Kmqt4DR1mrIM2JM03sokE7hVAW2+CO+8ks8ER5cgD1nItEmPAONAwrRwKMablSNIJ8yxDXNEkJX3YdJSJZWeKFxQDHS84LQOKAc/eNS0DEyHd2bn8GQdidxIjMUkcF5uFgoZoKpG4t61Om3ejMD6W2y2gB5enoO4+TxG3gVWFXGSK2MRCKRWMO5cCbVhKmmparfqkBVhZL6KK7mmX6ZtyES/7TtNIi4WTBqeZpmeSwjHF2jTqGgLABbjrXF+ZxgFJY1QFG5+MQ2zYW7m2YHJnCAOKpqFKTmhKBHi/P442RzHEqLwIWCAJzNDsHGo3GorlHQJjwHZ7NCxB6ttGi1T9q3zRdf58+n9iXy2MU9mq+lkj0/c849tXISiURiiRqhSmiVloJHFWSa0LVcDVZFFUpqemW1O9qEpyIuNB2Ma1qsr1cZBrY+Cl4jHtmJCJXV7ujYLA0tGovpruVVHthwtAM6RZ5H37gzaBeejvYRqegQcR7tI1LRyCffLPC93MsxoPUxeLpVgQg4lhGGS4W+6BeXgi5RZ9E+4jzaR5xH/9an0arJBaw52ApVNdbeAULgajcF8/eUKQ/w/Px8c8cBwNfXD9OnT/8jJqb507i4YA b5tB/KfXqOIPfgdURUY6xcIpH8u9m5c8eMt98W02otIbNWZxSq0Gmsajk9BA4vDxGYu7xK+L8CBHdFuGVVMzdUVQth56YAnm5VAKlltam9CnF4uFWL/XCzsoyySrGwoodbNdwUjuoaN1TVKBbt8XCrgZvCwDmhssbNYgVbtZwq6PUyVOSLOsxCVtu76GinTp1x//0PXh8U5F2K4t3rqWy/B+fV2+Eeul36eEkkEii+gO+1vyse/ut27fozYd68eTNU+aHX5Ixowlb9oRYy2FzVXENdVpqijbKWQlv7rRd+xjr0bbUUoJa/9fs0bqvWrc+zCBBjbHDPn r0RF9dq+8033zxo6lNPTEX1BaDqoq7xEonkXwt5YdvenG3bt/+5ffLkyTNKSgoTYFOQWQoo6ISYXrmznWeJtYCz1CCN6MtAJwT1QtGeBmoqYdUOvWC1lJu2+0kPPng/LygQC5jZKhwW1gTDhg3Hhg0bZ/n5+en3JZFIJA CAmJgW8b/++nM8DIJQoAkqvWCCWaBaY12HLazrVX+bS9jUPNXtNIGrlbOsU63D9EtXXk20NIVYtluUp/Hjx 1rfLiQSiURSL0jjqkQikVxBpJCVSCSSSK4gUshKJRHIFkUJWIpFIriD/ByUR2VUbryaXAAAAAElFTkSuQmCC";
        const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', onclone: function(clonedDoc) {
                var cContainer = clonedDoc.getElementById('simContainer'); 
                cContainer.classList.add('print-mode');
                
                var headerHTML = `<div class="title-block-container"><div class="tb-logo-area"><img src="${logoUrl}" class="tb-logo-img" alt="LOGO"></div><div class="tb-info-area"><div class="tb-cell"><label>PROJETO:</label><span>INSTALAÇÃO BBU 5900</span></div><div class="tb-cell"><label>TIPO:</label><span>IMPLANTAÇÃO DE REDE</span></div><div class="tb-cell" style="border-right:none;"><label>DATA:</label><span>${new Date().toLocaleDateString()}</span></div><div class="tb-cell"><label>SITE ID:</label><span>${siteNames.local || 'N/A'}</span></div><div class="tb-cell"><label>CIDADE/UF:</label><span style="color:#000; text-transform:uppercase;">${city}</span></div><div class="tb-cell" style="border-right:none;"><label>BBU:</label><span>HUAWEI 5900</span></div><div class="tb-cell" style="border-bottom:none;"><label>PROJETISTA:</label><span style="color:#000; text-transform:uppercase;">${designer}</span></div><div class="tb-cell" style="border-bottom:none;"><label>SETOR:</label><span>ENGENHARIA</span></div><div class="tb-cell" style="border-bottom:none; border-right:none;"><label>REV:</label><span>V.01 (AS-BUILT)</span></div></div></div>`;
                
                cContainer.insertAdjacentHTML('beforeend', headerHTML);
                
                var svgLayer = clonedDoc.getElementById('cableLayer'); 
                var originalPaths = Array.from(svgLayer.querySelectorAll('path'));
                originalPaths.forEach(path => { 
                    var outline = path.cloneNode(true); 
                    outline.setAttribute('stroke', '#000000'); 
                    outline.setAttribute('stroke-width', '5'); 
                    outline.style.opacity = '1'; 
                    svgLayer.insertBefore(outline, path); 
                    path.setAttribute('stroke-width', '2'); 
                    path.style.opacity = '1'; 
                });
                var circles = clonedDoc.querySelectorAll('svg circle'); 
                circles.forEach(c => svgLayer.appendChild(c));
            }
        });

        const imgData = canvas.toDataURL('image/png'); 
        var imgProps = pdf.getImageProperties(imgData);
        var pdfWidth = 297; 
        var pdfHeight = 210; 
        var ratio = pdfWidth / imgProps.width; 
        var finalHeight = imgProps.height * ratio;
        
        if(finalHeight > pdfHeight) { 
            ratio = pdfHeight / imgProps.height;
            var finalWidth = imgProps.width * ratio; 
            pdf.addImage(imgData, 'PNG', (pdfWidth - finalWidth)/2, 0, finalWidth, pdfHeight);
        } else { 
            pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, finalHeight); 
        }

        pdf.addPage('a4', 'portrait');
        let y = 20; const margin = 20;
        pdf.setTextColor(0, 0, 0); pdf.setFont("helvetica", "bold"); pdf.setFontSize(16);
        pdf.text("RELATÓRIO TÉCNICO DE INSTALAÇÃO (PIR)", margin, y); y += 8;
        pdf.setFontSize(10); pdf.setFont("helvetica", "normal"); pdf.text(`Projetista: ${designer} | Local: ${city}`, margin, y);
        y += 15;

        pdf.setFillColor(240, 240, 240); pdf.rect(margin, y, 170, 7, 'F'); pdf.setFont("helvetica", "bold");
        pdf.text("1. RESUMO DE ENERGIA E CAPACIDADE", margin + 2, y + 5); y += 12;
        const pData = atualizarPowerBudget();
        pdf.setFont("helvetica", "normal"); 
        pdf.text(`• Carga Atual Estimada: ${pData.load} Watts`, margin, y); y += 6;
        pdf.text(`• Capacidade Disponível (UPEU): ${pData.capacity} Watts`, margin, y); y += 6;
        let statusEnergia = "NORMAL";
        if(pData.capacity === 0) statusEnergia = "CRÍTICO (Sem Alimentação)"; else if(pData.load > pData.capacity) statusEnergia = "ALERTA (Sobrecarga)";
        pdf.text(`• Status do Sistema: ${statusEnergia}`, margin, y); y += 12;

        pdf.setFillColor(240, 240, 240); pdf.rect(margin, y, 170, 7, 'F'); pdf.setFont("helvetica", "bold");
        pdf.text("2. INVENTÁRIO DE HARDWARE (BBU)", margin + 2, y + 5); y += 12;
        pdf.setFontSize(9); let hardwareFound = false;
        
        for(let i=0; i<=19; i++) {
            if( (i>=0 && i<=7) || i===18 || i===19 ) {
                let slotEl = document.getElementById('bbuSlot' + i);
                let boardName = "Vazio"; let isInstalled = false;
                if(i===0 && slotEl && slotEl.classList.contains('fan-slot')) { 
                    boardName = "FAN Unit (Ventilação)";
                    isInstalled = true; 
                }
                else if(slotEl && !slotEl.classList.contains('bbu-slot-empty') && !slotEl.classList.contains('slot-dummy')) { 
                    let label = slotEl.querySelector('.installed-board-label');
                    if(label) { boardName = label.innerText; isInstalled = true; } 
                }
                
                if(isInstalled) {
                    pdf.setFont("helvetica", "bold");
                    pdf.text(`[SLOT ${i}] - ${boardName}`, margin, y); y += 5;
                    let slotConexoes = cableManager.cables.filter(c => c.connectedTo && c.connectedTo.includes(`Slot ${i}`));
                    if(slotConexoes.length > 0) {
                        pdf.setFont("helvetica", "normal");
                        slotConexoes.forEach(c => {
                            let porta = c.connectedTo.split('Port ')[1] || 'N/A'; 
                            let origem = c.siteOrigin || c.sourceType;
                            let extraInfo = (c.config && c.config.sector) ? ` (Setor ${c.config.sector} - ${c.config.radio})` : "";
                            pdf.text(`   -> Porta ${porta}: Conectado a ${origem}${extraInfo}`, margin + 5, y); y += 4;
                        });
                    } else { 
                        pdf.setFont("helvetica", "italic"); pdf.setTextColor(100); 
                        pdf.text(`   (Sem cabos conectados)`, margin + 5, y); pdf.setTextColor(0); y += 4;
                    }
                    y += 3;
                    hardwareFound = true;
                }
            }
            if(y > 270) { pdf.addPage(); y = 20; }
        }
        if(!hardwareFound) { pdf.setFont("helvetica", "italic"); pdf.text("Nenhuma placa instalada.", margin, y); y += 10; } y += 5;

        pdf.setFillColor(240, 240, 240); pdf.rect(margin, y, 170, 7, 'F');
        pdf.setFont("helvetica", "bold"); pdf.setFontSize(10); pdf.text("3. TOPOLOGIA RF E SITES REMOTOS", margin + 2, y + 5); y += 12;
        let siteCables = cableManager.cables.filter(c => c.sourceType === 'LOCAL' || c.sourceType === 'REMOTE');
        if(siteCables.length > 0) {
            let uniqueSites = [...new Set(siteCables.map(c => c.siteOrigin))];
            uniqueSites.forEach(site => {
                pdf.setFont("helvetica", "bold"); pdf.text(`SITE: ${site}`, margin, y); y += 5;
                siteCables.filter(c => c.siteOrigin === site).forEach(c => {
                    pdf.setFont("helvetica", "normal");
                    let setor = c.config.sector || "N/C"; 
                    let radio = c.config.radio || "Genérico";
                    let tech = ""; 
                    if(c.config.lteCount > 0) tech += `LTE(${c.config.lteCount}x) `; 
                    if(c.config.nrBw > 0) tech += `5G(NR) `;
                    pdf.text(`   - Setor ${setor}: ${radio} [${tech}]`, margin, y); y += 5;
                }); y += 3;
            });
        } else { 
            pdf.setFont("helvetica", "normal"); pdf.text("Nenhuma RRU conectada.", margin, y);
        }
        
        if(y > 230) { pdf.addPage(); y = 20; }

        y += 10;
        pdf.setFillColor(52, 152, 219);
        pdf.rect(margin, y, 170, 7, 'F'); 
        pdf.setTextColor(255, 255, 255);
        pdf.setFont("helvetica", "bold");
        pdf.text("4. ESTIMATIVA DE INVESTIMENTO (CAPEX)", margin + 2, y + 5); 
        
        y += 12;
        pdf.setTextColor(0, 0, 0);
        let techData = generateTechnicalData();
        pdf.setFontSize(9);
        pdf.setFont("helvetica", "bold");
        pdf.text("ITEM", margin, y);
        pdf.text("VALOR UNIT.", margin + 130, y);
        
        y += 5;
        pdf.line(margin, y, margin + 170, y); 
        y += 5;
        pdf.setFont("helvetica", "normal");
        
        techData.inventory.forEach(item => {
             let nome = item.model.length > 50 ? item.model.substring(0,50)+"..." : item.model;
             pdf.text(`(Slot ${item.slot}) ${nome}`, margin, y);
             pdf.text(item.price, margin + 130, y);
             y += 5;
        });
        y += 2;
        pdf.line(margin, y, margin + 170, y); 
        y += 6;
        pdf.setFontSize(11);
        pdf.setFont("helvetica", "bold");
        pdf.text("TOTAL ESTIMADO:", margin + 80, y);
        pdf.setTextColor(200, 0, 0); 
        pdf.text(techData.financial.totalCapex, margin + 130, y);
        
        pdf.save(`Projeto_Executivo_${siteNames.local || 'SAGE'}.pdf`);
        showNotification("Projeto exportado com sucesso!", "success");
    } catch (err) { 
        console.error(err); showNotification("Erro PDF: " + err.message, "error");
    }
    finally { 
        btn.innerHTML = oldText;
    }
}

function generateTechnicalData() {
    var pData = atualizarPowerBudget();
    var validationErrors = validarAntesDoDeploy();
    var inventoryList = [];
    var totalCost = 0;
    
    function parsePrice(priceStr) {
        if(!priceStr) return 0;
        var clean = priceStr.replace("R$", "").replace(/\./g, "").replace(",", ".").trim();
        return parseFloat(clean) || 0;
    }

    for (var i = 0; i <= 19; i++) {
        if ((i >= 0 && i <= 7) || i === 18 || i === 19) {
            var slotEl = document.getElementById('bbuSlot' + i);
            var boardName = "EMPTY"; 
            var boardType = "N/A"; 
            var isInstalled = false;
            var boardPrice = "R$ 0,00";
            
            if (i === 0 && slotEl && slotEl.classList.contains('fan-slot')) { 
                boardName = "FAN Unit";
                boardType = "FAN"; 
                isInstalled = true;
                boardPrice = "R$ 1.500,00";
            } 
            else if (slotEl && !slotEl.classList.contains('bbu-slot-empty') && !slotEl.classList.contains('slot-dummy')) {
                var label = slotEl.querySelector('.installed-board-label');
                if (label) { 
                    boardName = label.innerText;
                    if(boardName.includes('UPEU')) boardType = 'UPEU';
                    else boardType = boardName.includes('UMPT') ? 'UMPT' : 'UBBP'; 
                    isInstalled = true;
                    
                    if(boardType === 'UPEU') {
                        var us = getUpeuSpecs(boardName);
                        boardPrice = us.price;
                    } else {
                        var specs = getBoardSpecs(boardName);
                        if(specs && specs.price) boardPrice = specs.price;
                    }
                }
            }

            if (isInstalled) {
                var faultKey = "slot_" + i;
                var healthStatus = activeFaults[faultKey] ? activeFaults[faultKey] : "NORMAL";
                totalCost += parsePrice(boardPrice);
                inventoryList.push({ 
                    slot: i, 
                    model: boardName, 
                    type: boardType, 
                    health: healthStatus,
                    price: boardPrice 
                });
            }
        }
    }

    var formattedTotal = totalCost.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    var connections = cableManager.cables.filter(c => c.connectedTo).map(function(c) {
        var rfDetail = "N/A";
        if (c.config && (c.config.sector || c.config.radio)) {
            var tech = []; 
            if (c.config.lteCount > 0) tech.push("LTE x" + c.config.lteCount); 
            if (c.config.nrBw > 0) tech.push("NR " + c.config.nrBw + "MHz");
            
            rfDetail = `Setor ${c.config.sector} | ${c.config.radio} [${tech.join(', ')}]`;
        }
        return { 
            id: c.id, 
            category: c.sourceType, 
            origin: c.siteOrigin || c.sourceType, 
            destination: c.connectedTo, 
            rfConfig: rfDetail, 
            status: c.polarityStatus ? `Polarity: ${c.polarityStatus}` : "CONNECTED" 
        };
    });
    
    return {
        header: { 
            project: "INSTALAÇÃO BBU 5900", 
            siteId: siteNames.local || "LOCAL", 
            timestamp: new Date().toLocaleString(), 
            designer: document.getElementById('inDesignerName') ? document.getElementById('inDesignerName').value : "Técnico" 
        },
        power: { 
            loadWatts: pData.load, 
            capacityWatts: pData.capacity, 
            usage: ((pData.capacity > 0) ? (pData.load / pData.capacity) * 100 : 0).toFixed(1) + "%", 
            alertLevel: pData.overloaded ? "CRITICAL OVERLOAD" : "NORMAL" 
        },
        financial: { 
            totalCapex: formattedTotal,
            currency: "BRL"
        },
        inventory: inventoryList, 
        cabling: connections,
        validation: { 
            readyForDeploy: (validationErrors.length === 0), 
            blockers: validationErrors, 
            activeFaults: Object.keys(activeFaults).map(k => `${k}: ${activeFaults[k]}`) 
        }
    };
}

function downloadTechnicalReport(format) {
    var data = generateTechnicalData();
    var content = ""; 
    var mimeType = "";
    var extension = "";
    
    if (format === 'json') { 
        content = JSON.stringify(data, null, 4);
        mimeType = "application/json"; 
        extension = "json";
    } 
    else if (format === 'csv') {
        content = "Slot;Modelo;Tipo;Status;Valor Unitario\n";
        data.inventory.forEach(b => { 
            content += `${b.slot};${b.model};${b.type};${b.health};${b.price}\n`; 
        });
        content += `;;;TOTAL CAPEX;${data.financial.totalCapex}\n`;
        content += "\nTipo Cabo;Origem;Destino;Info RF;Status\n"; 
        data.cabling.forEach(c => { 
            content += `${c.category};${c.origin};${c.destination};${c.rfConfig};${c.status}\n`; 
        });
        mimeType = "text/csv"; 
        extension = "csv";
    } else {
        content += "==================================================\n   RELATÓRIO TÉCNICO DE COMISSIONAMENTO (BBU Architect)\n==================================================\n";
        content += `DATA: ${data.header.timestamp}\nSITE ID: ${data.header.siteId}\nRESPONSÁVEL: ${data.header.designer}\n\n`;
        content += "[1. STATUS DE ENERGIA]\n";
        content += `   Consumo: ${data.power.loadWatts}W / ${data.power.capacityWatts}W\n   Carga: ${data.power.usage}\n   Status: ${data.power.alertLevel}\n\n`;
        content += "[2. INVENTÁRIO & ORÇAMENTO]\n"; 
        if(data.inventory.length === 0) content += "   (Nenhum hardware instalado)\n";
        data.inventory.forEach(board => { 
            let line = `   [SLOT ${board.slot}] ${board.model}`;
            let price = ` | ${board.price}`;
            while(line.length < 50) line += " ";
            content += line + price + "\n"; 
        });
        content += `\n   --------------------------------------------------\n`;
        content += `   INVESTIMENTO TOTAL (CAPEX): ${data.financial.totalCapex}\n`;
        content += `   --------------------------------------------------\n`;

        content += "\n[3. MATRIZ DE CONEXÕES (CABLING)]\n";
        if(data.cabling.length === 0) content += "   (Nenhum cabo conectado)\n";
        data.cabling.forEach(c => { 
            content += `   TYPE: ${c.category.padEnd(8)} | DE: ${c.origin.padEnd(15)} -> PARA: ${c.destination}\n`; 
            if(c.rfConfig !== "N/A") content += `         └-> RF CONFIG: ${c.rfConfig}\n`; 
        });
        content += "\n[4. VALIDAÇÃO E DEPLOY]\n"; 
        content += `   DEPLOY PERMITIDO: ${data.validation.readyForDeploy ? "SIM" : "NÃO"}\n`;
        if (data.validation.blockers.length > 0) { 
            data.validation.blockers.forEach(err => content += `   [X] BLOQUEIO: ${err}\n`);
        } else { 
            content += "   [OK] Sistema validado e pronto para operação.\n";
        }
        mimeType = "text/plain"; 
        extension = "txt";
    }
    
    var blob = new Blob([content], {type: mimeType}); 
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `Relatorio_Tecnico_${data.header.siteId}.${extension}`; 
    document.body.appendChild(link); 
    link.click(); 
    document.body.removeChild(link); 
    showNotification(`Relatório ${extension.toUpperCase()} gerado!`, "success");
}

function downloadBonusManual() {
    var btn = document.querySelector('#btnFinalDownloadManual');
    var originalText = "";
    if(btn) { 
        originalText = btn.innerHTML; 
        btn.innerHTML = '<span class="material-icons" style="font-size:16px; animation:spin 1s infinite linear">refresh</span> ABRINDO MANUAL...'; 
        btn.disabled = true;
    }
    
    // Versão Web: Abre o manual.html diretamente
    setTimeout(function() {
        window.open('manual.html', '_blank');
        showNotification("Manual aberto em nova aba.", "success");
        setTimeout(gerarCertificadoPDF, 1500);
        if(btn) { btn.innerHTML = originalText; btn.disabled = false; }
    }, 1000);
}

async function gerarCertificadoPDF() {
    document.getElementById('certStudentName').innerText = studentData.name || "ALUNO BBU Architect";
    document.getElementById('certStudentRole').innerText = studentData.role || "Técnico";
    document.getElementById('certDate').innerText = new Date().toLocaleDateString();
    document.getElementById('certHash').innerText = "VALIDAÇÃO: 5900-" + Math.random().toString(36).substr(2, 9).toUpperCase();
    
    showNotification("Gerando Certificado de Alta Resolução...", "warning");
    const element = document.getElementById('certificateTemplate');
    
    try {
        const canvas = await html2canvas(element, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
        const { jsPDF } = window.jspdf; 
        const pdf = new jsPDF('l', 'mm', 'a4'); 
        const imgData = canvas.toDataURL('image/png');
        pdf.addImage(imgData, 'PNG', 0, 0, 297, 210);
        pdf.save(`Certificado_SAGE_${studentData.name.replace(/\s+/g, '_')}.pdf`); 
        showNotification("Certificado gerado com sucesso!", "success");
    } catch (err) { 
        console.error(err);
        showNotification("Erro ao gerar certificado: " + err.message, "error"); 
    }
}
 // =========================================================
  // --- 13. LÓGICA DO TUTORIAL (ONBOARDING) ---
  // =========================================================

  var tutorialStep = 0;
  function iniciarTutorial() {
      tutorialStep = 0;
      document.getElementById('tutorialOverlay').style.display = 'flex';
      renderizarPassoTutorial();
  }

  function fecharTutorial() {
      limparDestaques();
      document.getElementById('tutorialOverlay').style.display = 'none';
      showWelcomeTip();
  }

  function renderizarPassoTutorial() {
      var dados = tutorialData[tutorialStep];
      document.getElementById('tutoTitle').innerText = dados.title;
      document.getElementById('tutoText').innerHTML = dados.text;
      document.getElementById('tutoStepCount').innerText = (tutorialStep + 1) + " / " + tutorialData.length;
      var btnNext = document.querySelector('.btn-next');
      if(tutorialStep === tutorialData.length - 1) {
          btnNext.innerText = "Concluir";
          btnNext.onclick = fecharTutorial;
      } else {
          btnNext.innerText = "Próximo ➝";
          btnNext.onclick = proximoPassoTutorial;
      }

      // Gerencia Destaques (Highlights)
      limparDestaques();
      if (dados.targetId) {
          var el = document.getElementById(dados.targetId);
          if(el) el.classList.add('tutorial-highlight');
      } else if (dados.highlightClass) {
          var el = document.querySelector('.' + dados.highlightClass);
          if(el) el.classList.add('tutorial-highlight');
          // Caso especial: se for header-actions, destaca os botões de ação também
          if(dados.highlightClass === 'header-actions') {
              var exportBtn = document.querySelector('.export-btn');
              if(exportBtn) exportBtn.classList.add('tutorial-highlight');
          }
          // Caso especial: se for sobre controle UMPT/GPS, destaca ambos
          if(dados.title.includes("Controle")) {
              var gps = document.getElementById('gpsBox');
              if(gps) gps.classList.add('tutorial-highlight');
          }
      }
  }

  function proximoPassoTutorial() {
      if(tutorialStep < tutorialData.length - 1) {
          tutorialStep++;
          renderizarPassoTutorial();
      } else {
          fecharTutorial();
      }
  }

  function limparDestaques() {
      var highlighted = document.querySelectorAll('.tutorial-highlight');
      highlighted.forEach(el => el.classList.remove('tutorial-highlight'));
  }

// =========================================================
// BBU ARCHITECT SIMULATOR - SCRIPT.JS (Parte 5-2-B - FINAL)
// =========================================================
// Função 1: Apenas abre a janela (ligada ao botão da barra)
function exportarCenarioJSON() {
    // Sugere um nome automático baseado no site atual
    var nomeSugestao = (siteNames.local || "Site_BBU") + "_Config";
    document.getElementById('inScenarioName').value = nomeSugestao;
    
    // Abre o modal
    document.getElementById('saveScenarioModal').style.display = 'flex';
    document.getElementById('inScenarioName').focus();
}

// Função 2: Executa o salvamento real (ligada ao botão do modal)
function confirmarDownloadCenario() {
    try {
        var nomeArquivo = document.getElementById('inScenarioName').value.trim();
        if (!nomeArquivo) nomeArquivo = "Cenario_Sem_Nome";
        
        var elNotas = document.getElementById('inScenarioNotes');
        var notasEngenharia = elNotas ? elNotas.value : "";

        document.getElementById('saveScenarioModal').style.display = 'none';

        // 1. Inventário
        var currentInventory = [];
        for (var i = 0; i <= 19; i++) {
            var slot = document.getElementById('bbuSlot' + i);
            if (slot && !slot.classList.contains('bbu-slot-empty') && !slot.classList.contains('slot-dummy')) {
                 var label = slot.querySelector('.installed-board-label');
                 if (label) {
                     var type = slot.getAttribute('data-accept');
                     if (label.innerText.includes('UPEU')) type = 'UPEU';
                     currentInventory.push({ slot: i, model: label.innerText, type: type });
                 }
            }
        }

        // 2. Dummies
        var currentDummies = [];
        document.querySelectorAll('.slot-dummy').forEach(function(el) {
            var slotId = el.getAttribute('data-slot');
            if (slotId) currentDummies.push(slotId);
        });

        // 3. SFPs
        var installedSFPs = [];
        document.querySelectorAll('.bbu-port').forEach(function(port) {
            if (port.classList.contains('has-sfp') || port.getAttribute('data-has-sfp') === 'true') {
                installedSFPs.push({ slot: port.getAttribute('data-slot'), pid: port.getAttribute('data-pid') });
            }
        });

        // 4. USBs
        var installedUSBs = [];
        document.querySelectorAll('.usb-stick-inserted').forEach(function(usb) {
            var port = usb.parentElement;
            if (port) installedUSBs.push({ slot: port.getAttribute('data-slot') });
        });

        // 5. Captura Posições (CORREÇÃO AQUI: IGNORA CAIXAS OCULTAS)
        var boxPositions = [];
        document.querySelectorAll('.draggable-box').forEach(function(el) {
            // Se o elemento estiver oculto (display:none), offsetParent retorna null.
            if (el.offsetParent === null) return; 

            var style = window.getComputedStyle(el);
            var topVal = el.style.top || style.top;
            var leftVal = el.style.left || style.left;

            var nameLabel = el.querySelector('.site-name-display');
            boxPositions.push({
                id: el.id,
                name: nameLabel ? nameLabel.innerText : "",
                top: topVal,
                left: leftVal
            });
        });

        // 6. Monta Objeto
        var saveData = {
            version: "1.6",
            timestamp: new Date().getTime(),
            siteName: (typeof siteNames !== 'undefined' && siteNames.local) ? siteNames.local : "SITE_BBU",
            remoteSiteName: (typeof siteNames !== 'undefined' && siteNames.remote) ? siteNames.remote : null,
            notes: notasEngenharia,
            inventory: currentInventory,
            dummies: currentDummies,
            sfps: installedSFPs,
            usbs: installedUSBs,
            cables: (typeof cableManager !== 'undefined' && cableManager.cables) ? cableManager.cables : [],
            switches: typeof dcduSwitches !== 'undefined' ? dcduSwitches : {},
            faults: typeof activeFaults !== 'undefined' ? activeFaults : {},
            savedBoxes: boxPositions
        };

        // 7. Download
        var dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(saveData));
        var downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        if (!nomeArquivo.toLowerCase().endsWith(".json")) nomeArquivo += ".json";
        downloadAnchorNode.setAttribute("download", nomeArquivo);
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
        
        if(elNotas) elNotas.value = "";
        showNotification("Cenário salvo com sucesso!", "success");

    } catch (err) {
        console.error(err);
        alert("Erro ao salvar: " + err.message);
    }
}
// --- 10. IMPORTAÇÃO DE CENÁRIOS (.JSON) ---

function processarArquivoImportado(inputElement) {
    var file = inputElement.files[0];
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function(e) {
        try {
            var content = e.target.result;
            var data = JSON.parse(content);
            importarCenarioJSON(data);
        } catch (err) {
            console.error(err);
            showNotification("Erro ao ler arquivo: " + err.message, "error");
        }
        inputElement.value = '';
    };
    reader.readAsText(file);
}

function importarCenarioJSON(data) {
    // Limpa sem resetar o curso
    if(typeof limparSimulacao === 'function') limparSimulacao(false);
    else cableManager.clearCables(); // Fallback se a função não existir no escopo global
    
    showNotification("Restaurando cenário...", "warning");
    
    setTimeout(function() {
        // 1. Dados Básicos
        if (data.siteName) {
            siteNames.local = data.siteName;
            document.getElementById('txtLocal').innerText = data.siteName;
        }
        
        var isDualSite = false;
        if (data.remoteSiteName) {
            siteNames.remote = data.remoteSiteName;
            var inputCentral = document.getElementById('inSiteCentral');
            if (inputCentral) inputCentral.value = data.remoteSiteName;
            isDualSite = true;
        } else {
            siteNames.remote = null;
        }

        // 2. Restauração de Posições
        if (data.savedBoxes) {
            data.savedBoxes.forEach(function(box) {
                var el = document.getElementById(box.id);
                if (el) {
                    el.style.top = box.top;
                    el.style.left = box.left;
                    if (box.id === 'oduRemote') {
                        if (isDualSite) {
                            if (box.name) el.querySelector('.site-name-display').innerText = box.name;
                            el.style.display = 'flex';
                            document.getElementById('headerRemote').innerText = "SITE REMOTO";
                        } else {
                            el.style.display = 'none';
                        }
                    } else if (box.name) {
                         el.querySelector('.site-name-display').innerText = box.name;
                    }
                } else {
                    createSiteBox(box.name, box.id, box.top.replace('px',''), box.left.replace('px',''));
                }
            });
        }
        
        // 3. Inventário
        if (data.inventory) {
            data.inventory.forEach(function(item) {
                var slot = document.getElementById('bbuSlot' + item.slot);
                if (slot) installBoard(slot, { model: item.model, type: item.type });
            });
        }
        
        // 4. Dummies
        if (data.dummies) {
            data.dummies.forEach(function(slotId) {
                var slot = document.getElementById('bbuSlot' + slotId);
                if (slot) { slot.classList.remove('bbu-slot-empty'); slot.classList.add('slot-dummy'); }
            });
        }
        
        // 5. SFPs
        if (data.sfps) {
            data.sfps.forEach(function(item) {
                var selector = '.bbu-port[data-slot="' + item.slot + '"][data-pid="' + item.pid + '"]';
                var portEl = document.querySelector(selector);
                if (!portEl) {
                     var slotEl = document.getElementById('bbuSlot' + item.slot);
                     if (slotEl) portEl = slotEl.querySelector('[data-pid="' + item.pid + '"]');
                }
                if (portEl) { portEl.classList.add('has-sfp'); portEl.setAttribute('data-has-sfp', 'true'); }
            });
        }
        
        // 6. USBs
        if (data.usbs) {
            data.usbs.forEach(function(item) {
                var selector = '.port-usb-v[data-slot="' + item.slot + '"]';
                var portEl = document.querySelector(selector);
                if (portEl && !portEl.querySelector('.usb-stick-inserted')) {
                     var stick = document.createElement('div');
                     stick.className = 'usb-stick-inserted'; stick.title = "Remover USB";
                     stick.onclick = function(e) { e.stopPropagation(); removerUSB(this); }; 
                     portEl.appendChild(stick);
                }
            });
        }
        
        // 7. Cabos e Estado
        if (data.cables) { 
            cableManager.cables = data.cables;
            cableManager.render(); 
        }
        if (data.switches) dcduSwitches = data.switches;
        if (data.faults) activeFaults = data.faults;
        
        for (var key in dcduSwitches) {
            if (dcduSwitches[key]) {
                var sw = document.getElementById('sw' + key);
                if (sw) sw.classList.add('on');
            }
        }

        verificarEstadoSimulador();
        atualizarPowerBudget();
        manageSystemHealth();
        atualizarContadoresGeral();

        showNotification("Cenário restaurado com sucesso!", "success");

        if (data.notes && data.notes.trim() !== "") {
            document.getElementById('lblLoadDate').innerText = new Date(data.timestamp).toLocaleString();
            document.getElementById('lblLoadSite').innerText = data.siteName || "N/A";
            document.getElementById('lblLoadNotes').innerText = data.notes;
            setTimeout(function() {
                document.getElementById('projectNotesModal').style.display = 'flex';
            }, 800);
        }

    }, 500);
}

// --- 11. MÓDULO TORRE & INSTRUTOR ---

function abrirModoTorre() {
    var temCaboRemoto = cableManager.cables.some(function(c){ return c.sourceType === 'REMOTE'; });
    if(!temCaboRemoto) { showNotification("Crie cabos no SITE REMOTO primeiro!", "warning"); return; }
    
    // Como não temos o HTML do modal da torre embutido, criamos dinamicamente se não existir
    if(!document.getElementById('towerInstallOverlay')) {
        createTowerUI();
    }
    
    document.getElementById('towerInstallOverlay').style.display = 'flex';
    towerState.active = true; 
    atualizarChecklistVisual();
}

function createTowerUI() {
    // Criação dinâmica da interface da Torre se não existir no HTML base
    var html = `
    <div id="towerInstallOverlay" class="custom-modal-overlay" style="z-index: 35000; display:none; flex-direction:row;">
        <div style="width:200px; background:#1e1e24; border-right:1px solid #333; padding:15px; display:flex; flex-direction:column; gap:10px;">
            <h3 style="color:#3498db; font-size:14px; margin-bottom:10px;">FERRAMENTAS</h3>
            <div class="tower-part-item" draggable="true" ondragstart="dragTowerPart(event, 'bracket')" style="background:#444; padding:10px; border-radius:4px; cursor:grab; text-align:center;">
                <span class="material-icons">construction</span> Suporte
            </div>
            <div class="tower-part-item" draggable="true" ondragstart="dragTowerPart(event, 'rru')" style="background:#444; padding:10px; border-radius:4px; cursor:grab; text-align:center;">
                <span class="material-icons">router</span> Rádio (RRU)
            </div>
            <div class="tower-part-item" draggable="true" ondragstart="dragTowerPart(event, 'grounding')" style="background:#444; padding:10px; border-radius:4px; cursor:grab; text-align:center;">
                <span class="material-icons">electrical_services</span> Aterramento
            </div>
            <div class="tower-part-item" draggable="true" ondragstart="dragTowerPart(event, 'fiber')" style="background:#444; padding:10px; border-radius:4px; cursor:grab; text-align:center;">
                <span class="material-icons">cable</span> Cabo Híbrido
            </div>
            <div class="tower-part-item" draggable="true" ondragstart="dragTowerPart(event, 'tape')" style="background:#444; padding:10px; border-radius:4px; cursor:grab; text-align:center;">
                <span class="material-icons">format_paint</span> Vedação (Cold Shrink)
            </div>
            <button class="btn-cancel" onclick="fecharModoTorre()" style="margin-top:auto;">SAIR DA TORRE</button>
        </div>
        
        <div style="flex:1; background:linear-gradient(to bottom, #87ceeb 0%, #e0f7fa 100%); position:relative; overflow:hidden;" ondrop="dropTowerPart(event)" ondragover="allowDropTower(event)">
            <div id="towerPole" style="position:absolute; left:50%; top:0; bottom:0; width:60px; background:linear-gradient(90deg, #555, #777, #555); transform:translateX(-50%);"></div>
            <div style="position:absolute; bottom:10px; left:10px; color:#333; font-weight:bold; font-size:10px;">RAIO DE SEGURANÇA: 2m</div>
        </div>
        
        <div style="width:200px; background:#1e1e24; border-left:1px solid #333; padding:15px;">
            <h3 style="color:#2ecc71; font-size:14px; margin-bottom:10px;">CHECKLIST</h3>
            <ul style="list-style:none; padding:0; font-size:12px; color:#aaa; line-height:2;">
                <li id="chkBracket">⚪ Fixar Suporte</li>
                <li id="chkRRU">⚪ Içar RRU</li>
                <li id="chkGround">⚪ Aterramento</li>
                <li id="chkCabo">⚪ Cabo Óptico/DC</li>
                <li id="chkVeda">⚪ Impermeabilização</li>
            </ul>
            <div id="towerStatusInfo" style="margin-top:20px; font-weight:bold; color:#f1c40f; text-align:center;">EM PROGRESSO...</div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
}

function fecharModoTorre() { document.getElementById('towerInstallOverlay').style.display = 'none'; towerState.active = false; }
function dragTowerPart(ev, type) { ev.dataTransfer.setData("partType", type); }
function allowDropTower(ev) { ev.preventDefault(); }

function dropTowerPart(ev) {
    ev.preventDefault(); 
    var type = ev.dataTransfer.getData("partType"); 
    var pole = document.getElementById('towerPole');
    
    if (type === 'bracket') { 
        if (towerState.hasBracket) return showNotification("Suporte já instalado.", "warning"); 
        var div = document.createElement('div'); div.className = 'bracket-visual'; pole.appendChild(div);
        towerState.hasBracket = true; showNotification("Suporte fixado com sucesso!", "success"); 
    }
    else if (type === 'rru') { 
        if (!towerState.hasBracket) return showNotification("Instale o suporte primeiro!", "error");
        if (towerState.hasRRU) return showNotification("RRU já instalada.", "warning"); 
        var rruHtml = '<div class="rru-visual" id="installedRRU">' + '<div class="rru-fins"></div>' + '<div class="rru-label">Huawei</div>' + '<div class="rru-port-din" id="rruPort" title="Porta de Fibra/DC"></div>' + '</div>';
        pole.insertAdjacentHTML('beforeend', rruHtml); 
        towerState.hasRRU = true; showNotification("RRU içada e fixada no suporte.", "success");
    }
    else if (type === 'grounding') { 
        if (!towerState.hasRRU) return showNotification("Precisa da RRU para aterrar.", "error");
        if (towerState.isGrounded) return showNotification("Já está aterrado.", "warning"); 
        var rru = document.getElementById('installedRRU'); 
        var groundDiv = document.createElement('div'); groundDiv.className = 'ground-wire-visual'; rru.appendChild(groundDiv);
        towerState.isGrounded = true; showNotification("Aterramento conectado. Proteção OK.", "success"); 
    }
    else if (type === 'fiber') { 
        if (!towerState.hasRRU) return showNotification("Onde você vai ligar o cabo? Instale a RRU.", "error");
        if (!towerState.isGrounded) return showNotification("PERIGO: Aterre o equipamento antes de ligar cabos!", "error"); 
        if (towerState.cableConnected) return showNotification("Cabo já conectado.", "warning");
        
        var caboLivre = cableManager.cables.find(function(c) { return c.sourceType === 'REMOTE' && !c.connectedTo; }); 
        if (caboLivre) { 
            var port = document.getElementById('rruPort'); port.classList.add('connected');
            caboLivre.connectedTo = "RRU (Torre)"; 
            towerState.connectedCableId = caboLivre.id; 
            towerState.cableConnected = true; 
            showNotification("Cabo óptico conectado à RRU!", "success");
        } else { 
            showNotification("Sem cabos livres vindo da BBU (Remoto).", "error");
        } 
    }
    else if (type === 'tape') { 
        if (!towerState.cableConnected) return showNotification("Conecte o cabo antes de vedar.", "warning");
        if (towerState.isWeatherproofed) return showNotification("Já está vedado.", "warning"); 
        var port = document.getElementById('rruPort'); port.classList.add('weatherproofed'); 
        towerState.isWeatherproofed = true; 
        showNotification("Conector impermeabilizado. VSWR protegido.", "success");
    }
    atualizarChecklistVisual();
}

function atualizarChecklistVisual() {
    if(towerState.hasBracket) setCheck('chkBracket');
    if(towerState.hasRRU) setCheck('chkRRU'); 
    if(towerState.isGrounded) setCheck('chkGround'); 
    if(towerState.cableConnected) setCheck('chkCabo'); 
    if(towerState.isWeatherproofed) setCheck('chkVeda');
    
    var statusTxt = document.getElementById('towerStatusInfo');
    if (towerState.isWeatherproofed) { 
        statusTxt.innerHTML = '<span class="material-icons" style="color:#2ecc71">check_circle</span> INSTALAÇÃO COMPLETA';
    }
}

function setCheck(id) { 
    var el = document.getElementById(id); 
    if(el) { 
        el.classList.add('chk-done');
        el.innerHTML = '<span class="material-icons" style="font-size:12px; margin-right:5px;">check</span> ' + el.innerText.replace('⚪', '').trim();
    } 
}

// Hook para o duplo clique na caixa remota
setTimeout(function() {
    var boxRemote = document.getElementById('oduRemote');
    if(boxRemote) {
        boxRemote.ondblclick = function() { abrirModoTorre(); }; 
        boxRemote.setAttribute('title', 'Duplo Clique para Instalar RRU na Torre');
        var header = document.getElementById('headerRemote'); 
        if(header) header.innerHTML += ' <span class="material-icons" style="font-size:10px; cursor:pointer;" onclick="abrirModoTorre()">cell_tower</span>';
    }
}, 1000);

// --- PAINEL DO INSTRUTOR ---

function toggleInstructorPanel() {
    let panel = document.getElementById('instructorModal');
    if (!panel) { createInstructorUI(); panel = document.getElementById('instructorModal'); }
    panel.style.display = (panel.style.display === 'flex') ? 'none' : 'flex';
    if(panel.style.display === 'flex') populateFaultOptions();
}

function createInstructorUI() {
    var html = `
    <div id="instructorModal" class="custom-modal-overlay" style="z-index: 40000;">
        <div class="custom-modal-box" style="border-color: #e74c3c;">
            <h3 style="color:#e74c3c; border-bottom:1px solid #555; padding-bottom:10px;"><span class="material-icons">bug_report</span> PAINEL DO INSTRUTOR</h3>
            <div style="text-align:left; margin:15px 0;">
                <label style="color:#aaa; font-size:10px;">ALVO:</label><select id="instTarget" class="input-remote-site" style="width:100%; margin-bottom:10px;"></select>
                <label style="color:#aaa; font-size:10px;">TIPO DE FALHA:</label>
                <select id="instFaultType" class="input-remote-site" style="width:100%; margin-bottom:15px;">
                    <option value="OVERHEAT">Sobretemperatura (Temp High)</option>
                    <option value="SFP_FAIL">Falha no Laser SFP (TX Power Low)</option>
                    <option value="FAN_FAIL">Falha de Ventilação (Fan Stalled)</option>
                </select>
            </div>
            <div class="modal-buttons">
                <button class="btn-cancel" onclick="document.getElementById('instructorModal').style.display='none'">Fechar</button>
                <button class="btn-confirm" style="background:#e74c3c; color:white;" onclick="confirmInjection()">QUEBRAR!</button>
            </div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
}

function populateFaultOptions() {
    var sel = document.getElementById('instTarget'); sel.innerHTML = '';
    var optFan = document.createElement('option'); optFan.value = "slot_FAN"; optFan.text = "[SISTEMA] Unidade de Ventilação (FAN)"; sel.appendChild(optFan);
    for (var i = 0; i <= 7; i++) {
        var slot = document.getElementById('bbuSlot' + i);
        if (slot && !slot.classList.contains('bbu-slot-empty') && !slot.classList.contains('slot-dummy')) {
            var label = slot.querySelector('.installed-board-label'); var nomePlaca = label ? label.innerText : "Placa Genérica";
            var opt = document.createElement('option'); opt.value = "slot_" + i; opt.text = `Slot ${i}: ${nomePlaca}`; sel.appendChild(opt);
        }
    }
}

function confirmInjection() {
    var target = document.getElementById('instTarget').value;
    var type = document.getElementById('instFaultType').value;
    if(target) { 
        activeFaults[target] = type; 
        showNotification(`FALHA INJETADA: ${type}`, "warning"); 
        manageSystemHealth();
    }
    document.getElementById('instructorModal').style.display = 'none';
}

function showDiagnostics(slotId) {
    var faultKey = "slot_" + slotId;
    var fault = activeFaults[faultKey];
    if (!fault) { 
        if (activeFaults['slot_FAN'] === 'FAN_FAIL') { 
            showNotification(`ALERTA: Slot ${slotId} Temp Alta devido a falha na ventilação!`, "error");
        } else { 
            showNotification(`Slot ${slotId}: Status NORMAL. Temp: 42°C.`, "success"); 
        } 
        return;
    }
    if (fault === 'OVERHEAT') { showNotification(`ALERTA: Slot ${slotId} Temp Crítica (85°C)!`, "error"); } 
    else if (fault === 'SFP_FAIL') { showNotification(`ALERTA: Slot ${slotId} SFP Optical Power Low (-40dBm).`, "error"); }
}

function createConfirmationModalUI() {
    if(document.getElementById('customConfirmModal')) return;
    var html = `
    <div id="customConfirmModal" class="custom-modal-overlay" style="z-index: 50000; display:none;">
        <div class="custom-modal-box" style="border-color: #f1c40f;">
            <h3 style="color:#f1c40f; margin-bottom:15px; text-transform:uppercase;">Confirmação</h3>
            <p id="lblConfirmMsg" style="color:#ddd; font-size:13px; margin-bottom:20px;">...</p>
            <div class="modal-buttons"><button class="btn-cancel" onclick="closeConfirmModal()">CANCELAR</button><button class="btn-confirm" onclick="executeConfirmAction()">CONFIRMAR</button></div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
}

function showCustomConfirm(msg, callback) { 
    document.getElementById('lblConfirmMsg').innerText = msg; 
    pendingConfirmAction = callback; 
    document.getElementById('customConfirmModal').style.display = 'flex';
}
function closeConfirmModal() { 
    document.getElementById('customConfirmModal').style.display = 'none'; 
    pendingConfirmAction = null; 
}
function executeConfirmAction() { 
    if (pendingConfirmAction) pendingConfirmAction(); 
    closeConfirmModal();
}

// --- 12. TERMINAL LÓGICO ---

var terminalHistory = [];
var historyPointer = -1; 
const VALID_COMMANDS = ["LST ALM", "DSP BRD", "DSP VSWR", "CLS", "HELP", "DSP SFP", "SET DEVIP", "PING"];

function toggleConsole() {
    var modal = document.getElementById('consoleModal');
    var isHidden = (modal.style.display === 'none');
    modal.style.display = isHidden ? 'flex' : 'none';
    if (isHidden) { 
        document.getElementById('lblConsoleSite').innerText = siteNames.local || "LOCAL";
        setTimeout(function() { 
            var inp = document.getElementById('cmdInput');
            if(inp) inp.focus(); 
        }, 100);
    }
}

var cmdInputEl = document.getElementById('cmdInput');
if (cmdInputEl) {
    cmdInputEl.addEventListener("keydown", function(e) {
        var input = this;
        if (e.key === "Enter") { 
            executeCommand();
        } 
        else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (terminalHistory.length > 0) {
                if (historyPointer === -1) historyPointer = terminalHistory.length - 1;
                else if (historyPointer > 0) historyPointer--;
                input.value = terminalHistory[historyPointer];
            }
        }
        else if (e.key === "ArrowDown") {
            e.preventDefault();
            if (historyPointer !== -1) {
                if (historyPointer < terminalHistory.length - 1) {
                    historyPointer++;
                    input.value = terminalHistory[historyPointer];
                } else {
                    historyPointer = -1;
                    input.value = ""; 
                }
            }
        }
        else if (e.key === "Tab") {
            e.preventDefault();
            var current = input.value.toUpperCase();
            if (!current) return;
            var match = VALID_COMMANDS.find(function(c) { return c.startsWith(current); });
            if (match) input.value = match;
        }
    });
}

function executeCommand() {
    var inputEl = document.getElementById('cmdInput');
    var cmdRaw = inputEl.value.trim(); 
    if (!cmdRaw) return;

    terminalHistory.push(cmdRaw);
    historyPointer = -1;
    printConsoleLine(">> " + cmdRaw, "#2ecc71"); 
    inputEl.value = ""; 
    var cmd = cmdRaw.toUpperCase();

    if (cmd === 'DSP BRD') {
        printConsoleLine("+++    " + (siteNames.local || "LOCAL") + "  " + new Date().toLocaleString() , "#ccc");
        printConsoleLine("RETCODE = 0  Operation succeeded.", "#ccc"); 
        printConsoleLine(""); 
        printConsoleLine("Board Information", "res-header");
        printConsoleLine("--------------------------------------------------------------------------------------");
        printConsoleLine("Slot    Board Type      Operational State    Availability Status"); 
        printConsoleLine("--------------------------------------------------------------------------------------");
        
        for (var i = 0; i <= 7; i++) {
            var slot = document.getElementById('bbuSlot' + i);
            if (slot && !slot.classList.contains('bbu-slot-empty') && !slot.classList.contains('slot-dummy')) {
                var label = slot.querySelector('.installed-board-label');
                var type = label ? label.innerText : "UNKNOWN"; 
                var fault = activeFaults["slot_" + i]; 
                var state = "Normal";
                
                if (fault === 'OVERHEAT') state = "Fault"; 
                var lineHtml = `<span class="console-link" onclick="focusHardwareSlot(${i})">Slot ${i}</span>` + " &nbsp;&nbsp;&nbsp; " + type + " &nbsp;&nbsp; [" + state + "]";
                printConsoleLine(lineHtml, null, true);
            }
        }
        [18, 19].forEach(i => {
            var slot = document.getElementById('bbuSlot' + i);
            if (slot && !slot.classList.contains('bbu-slot-empty')) {
                var label = slot.querySelector('.installed-board-label');
                var type = label ? label.innerText : "UPEU";
                var lineHtml = `<span class="console-link" onclick="focusHardwareSlot(${i})">Slot ${i}</span>` + " &nbsp;&nbsp; " + type + " &nbsp;&nbsp; [Normal]";
                printConsoleLine(lineHtml, null, true);
            }
        });
        printConsoleLine("");
    }
    else if (cmd === 'LST ALM') {
        printConsoleLine("+++    " + (siteNames.local || "LOCAL") + "  " + new Date().toLocaleString() , "#ccc");
        var faultKeys = Object.keys(activeFaults);
        if (faultKeys.length === 0) { 
            printConsoleLine("RETCODE = 0  No alarm found.", "#ccc");
        } else {
            printConsoleLine("RETCODE = 0  Operation succeeded.", "#ccc");
            printConsoleLine("Alarm Information", "res-header"); 
            faultKeys.forEach(function(key, idx) {
                var type = activeFaults[key]; 
                var rowHtml = `<span class="t-col w-id" style="color:#e74c3c">${2600+idx}</span>` + `<span class="t-col w-name" style="color:#e74c3c">${type}</span>`;
                printConsoleLine(rowHtml, null, true);
            });
        }
    }
    else if (cmd === 'DSP VSWR') {
        if (!towerState.active && !towerState.cableConnected) { 
            printConsoleLine("RETCODE = 50322  The RF unit is not connected or configured.", "res-error");
        } else {
            printConsoleLine("RETCODE = 0  Operation succeeded.", "#ccc");
            var vswrVal = 1.05; 
            if (!towerState.isWeatherproofed) vswrVal = 1.65;
            if (!towerState.isGrounded) vswrVal = 1.30;
            if (!towerState.cableConnected) vswrVal = 99.9;
            var color = (vswrVal > 1.5) ? "#e74c3c" : "#e0e0e0";
            printConsoleLine("0         TX_A          " + vswrVal.toFixed(2), color);
        }
    }
    else if (cmd === 'SET DEVIP') {
        printConsoleLine("Starting Auto-Negotiation...", "#ccc");
        setTimeout(function() {
            transmissionState.ip = "10.20.30.40";
            transmissionState.gateway = "10.20.30.1";
            transmissionState.mask = "255.255.255.0";
            transmissionState.isConfigured = true;
            printConsoleLine("RETCODE = 0  IP Configured: 10.20.30.40", "#2ecc71");
            manageSystemHealth();
        }, 800);
    }
    else if (cmd.startsWith('PING')) {
        var temCabo = cableManager.cables.some(c => c.connectedTo && c.connectedTo.includes("Slot 7"));
        if (!transmissionState.isConfigured) printConsoleLine("Error: IP not configured.", "res-error");
        else if (!temCabo) printConsoleLine("Error: Link down.", "res-error");
        else {
            printConsoleLine("Reply from Gateway: bytes=32 time=4ms TTL=250");
        }
    }
    else if (cmd === 'CLS' || cmd === 'CLEAR') { 
        document.getElementById('consoleOutput').innerHTML = "";
    }
    else if (cmd === 'AQZ_PROVA') {
        var finalPanel = document.getElementById('panelFinalReport');
        if(finalPanel) {
            finalPanel.style.display = 'flex';
            var btnQuiz = finalPanel.querySelector('button[onclick="abrirModalCadastro()"]');
            if(btnQuiz) btnQuiz.style.display = 'flex';
            printConsoleLine("RETCODE = 0  Final Exam Access Granted.", "#2ecc71");
            setTimeout(function() { toggleConsole(); }, 1500);
        }
    }
    else { 
        printConsoleLine("Error: Unknown command '" + cmd + "'.", "res-error");
    }
    var out = document.getElementById('consoleOutput'); 
    out.scrollTop = out.scrollHeight;
}

function printConsoleLine(text, color, isHtml) { 
    var div = document.createElement('div'); 
    div.className = 'console-line';
    if (isHtml) div.innerHTML = text; else div.innerText = text;
    if (color) div.style.color = color; 
    document.getElementById('consoleOutput').appendChild(div);
}

function focusHardwareSlot(targetId) {
    toggleConsole();
    var el = (targetId === 'FAN') ? document.querySelector('.fan-slot') : document.getElementById('bbuSlot' + targetId);
    if (el) {
        el.classList.remove('slot-focus-blink');
        void el.offsetWidth; 
        el.classList.add('slot-focus-blink');
        setTimeout(function() { el.classList.remove('slot-focus-blink'); }, 4000);
    }
}

function quickCmd(commandText) { 
    var input = document.getElementById('cmdInput');
    if(input) { input.value = commandText; input.focus(); }
}

// --- 13. QUIZ FINAL ---

var studentData = { name: "", role: "" };
var userAnswers = {};

function abrirModalCadastro() {
    document.getElementById('panelFinalReport').style.display = 'none';
    document.getElementById('inQuizName').value = "";
    document.getElementById('inQuizRole').value = "";
    document.getElementById('quizRegModal').style.display = 'flex';
}

function iniciarProva() {
    var nome = document.getElementById('inQuizName').value.trim();
    var cargo = document.getElementById('inQuizRole').value.trim();
    if(!nome || !cargo) return showNotification("Preencha Nome e Cargo.", "warning");
    studentData.name = nome; studentData.role = cargo;
    document.getElementById('quizRegModal').style.display = 'none'; 
    document.getElementById('quizMainModal').style.display = 'flex';
    document.getElementById('lblStudentName').innerText = `${nome} - ${cargo}`; 
    renderizarQuestoes();
}

function renderizarQuestoes() {
    var container = document.getElementById('quizContainer');
    container.innerHTML = ""; userAnswers = {};
    document.getElementById('quizResultArea').style.display = 'none'; 
    document.getElementById('quizFooter').style.display = 'block';
    
    // QUIZ_DATA vem do data.js
    if(typeof QUIZ_DATA !== 'undefined') {
        QUIZ_DATA.forEach((item, idx) => {
            var html = `
            <div class="quiz-question-block" id="qBlock_${idx}">
                <div class="quiz-q-title">${item.q}</div>
                <div class="quiz-options-list">
                    ${item.opts.map((opt, optIdx) => `
                    <div class="quiz-opt" id="opt_${idx}_${optIdx}" onclick="selecionarOpcao(${idx}, ${optIdx})">
                            <span class="material-icons" id="icon_${idx}_${optIdx}" style="font-size:16px;">radio_button_unchecked</span>
                            ${opt}
                        </div>
    `).join('')}
                </div>
                <div class="explanation-box" id="exp_${idx}">
                    <strong>Explicação:</strong> ${item.exp}
                </div>
            </div>`;
            container.insertAdjacentHTML('beforeend', html);
        });
    }
}

function selecionarOpcao(qIdx, optIdx) {
    if(document.getElementById('quizResultArea').style.display === 'block') return;
    for(var i=0; i<4; i++) {
        var el = document.getElementById(`opt_${qIdx}_${i}`);
        var icon = document.getElementById(`icon_${qIdx}_${i}`);
        if(el) { el.classList.remove('selected'); icon.innerText = "radio_button_unchecked"; }
    }
    var selectedEl = document.getElementById(`opt_${qIdx}_${optIdx}`); 
    var selectedIcon = document.getElementById(`icon_${qIdx}_${optIdx}`);
    selectedEl.classList.add('selected'); 
    selectedIcon.innerText = "radio_button_checked"; 
    userAnswers[qIdx] = optIdx;
}

function calcularResultadoQuiz() {
    var respondidas = Object.keys(userAnswers).length;
    if(respondidas < 10) return showNotification(`Responda todas as questões.`, "warning");
    
    var acertos = 0;
    QUIZ_DATA.forEach((item, idx) => {
        var userChoice = userAnswers[idx]; 
        document.getElementById(`exp_${idx}`).style.display = 'block';
        var correctEl = document.getElementById(`opt_${idx}_${item.correct}`); 
        correctEl.classList.add('correct-answer'); 
        if(userChoice !== item.correct) { 
            var wrongEl = document.getElementById(`opt_${idx}_${userChoice}`); 
            wrongEl.classList.add('wrong-choice'); 
        } else { 
            acertos++; 
        }
    });
    
    document.getElementById('quizFooter').style.display = 'none'; 
    var resArea = document.getElementById('quizResultArea'); 
    resArea.style.display = 'block';
    
    var percent = Math.round((acertos / 10) * 100);
    var circle = document.getElementById('scoreCircle'); 
    circle.innerText = percent + "%";
    var txt = document.getElementById('scoreText'); 
    var actions = document.getElementById('quizActions');
    
    if(acertos >= 8) {
        circle.style.color = "#2ecc71";
        txt.innerHTML = `PARABÉNS! APROVADO.`;
        actions.innerHTML = `<button class="btn-confirm" onclick="finalizarQuizSucesso()"><span class="material-icons">file_download</span> BAIXAR MANUAL & CERTIFICADO</button>`;
    } else {
        circle.style.color = "#e74c3c";
        txt.innerHTML = `REPROVADO. Tente novamente.`;
        actions.innerHTML = `<button class="btn-cancel" onclick="iniciarProva()"><span class="material-icons">refresh</span> TENTAR NOVAMENTE</button>`;
    }
    resArea.scrollIntoView({ behavior: 'smooth' });
}

function finalizarQuizSucesso() {
    document.getElementById('quizMainModal').style.display = 'none'; 
    var panel = document.getElementById('panelFinalReport'); 
    panel.style.display = 'flex';
    var btnQuiz = panel.querySelector('button[onclick="abrirModalCadastro()"]'); 
    if(btnQuiz) btnQuiz.style.display = 'none';
    var btnDown = document.getElementById('btnFinalDownloadManual'); 
    btnDown.style.display = 'flex';
    showNotification("Certificação Concluída!", "success");
}

// Substitua a função antiga por esta:
// Substitua a função sairDaAvaliacao por esta:
function sairDaAvaliacao() {
    // 1. Fecha o Modal do Quiz Imediatamente
    document.getElementById('quizMainModal').style.display = 'none';
    
    // 2. Limpa os dados da prova
    userAnswers = {};
    var container = document.getElementById('quizContainer');
    if(container) container.innerHTML = "";
    
    // 3. Restaura o painel de Certificado (se existir)
    var panel = document.getElementById('panelFinalReport');
    if (panel) {
        panel.style.display = 'flex';
        var btnQuiz = panel.querySelector('button[onclick="abrirModalCadastro()"]');
        if(btnQuiz) btnQuiz.style.display = 'flex';
    }
    
    // 4. Manda a notificação com atraso de 1 segundo (1000ms)
    setTimeout(function() {
        showNotification("Avaliação cancelada.", "warning");
    }, 1000);
}
// =========================================================
// --- LÓGICA DO MAPA MENTAL INTERATIVO (NEON STYLE) ---
// =========================================================

// Dados Completos extraídos do arquivo React, com ícones convertidos para Material Icons
const BBU_FULL_DATA = {
  id: "bbu-5900", title: "BBU 5900 - Baseband Unit", description: "Unidade de processamento de banda base da Huawei para redes 4G/5G", color: "cyan", icon: "dns", // Server -> dns
  children: [
    {
      id: "hardware", title: "Hardware & Arquitetura", description: "Componentes físicos e estrutura do equipamento", color: "blue", icon: "inventory_2", // Box -> inventory_2
      children: [
        {
          id: "slots", title: "Slots e Placas", description: "Configuração de slots disponíveis", color: "blue", icon: "view_module", // Layers -> view_module
          children: [
            { id: "umpt", title: "UMPT (Universal Main Processing & Timing)", description: "Placa principal de processamento e sincronização", color: "cyan" },
            { id: "ubbp", title: "UBBP (Universal Baseband Processing)", description: "Processamento de banda base universal", color: "cyan" },
            { id: "upeu", title: "UPEU (Universal Power & Environment Unit)", description: "Unidade de energia e monitoramento ambiental", color: "green" },
            { id: "uscu", title: "USCU (Universal Satellite Card Unit)", description: "Unidade de sincronização por satélite GPS/BDS", color: "purple" },
            { id: "ufan", title: "UFAN (Universal Fan Module)", description: "Módulo de ventilação e resfriamento", color: "orange" },
          ]
        },
        {
          id: "interfaces", title: "Interfaces de Conexão", description: "Portas e conectores disponíveis", color: "blue", icon: "cable", // Cable -> cable
          children: [
            { id: "cpri", title: "CPRI", description: "Interface óptica para conexão com RRU", color: "cyan" },
            { id: "ecpri", title: "eCPRI", description: "Interface melhorada para 5G fronthaul", color: "green" },
            { id: "eth", title: "Ethernet (GE/10GE)", description: "Conexões para backhaul e O&M", color: "blue" },
            { id: "usb", title: "USB/Serial", description: "Portas de manutenção local", color: "orange" },
          ]
        },
        {
          id: "power", title: "Sistema de Energia", description: "Alimentação e proteção elétrica", color: "green", icon: "bolt", // Zap -> bolt
          children: [
            { id: "dc-input", title: "Entrada DC -48V", description: "Alimentação padrão telecom", color: "green" },
            { id: "redundancy", title: "Redundância de Energia", description: "Fontes redundantes para alta disponibilidade", color: "green" },
            { id: "protection", title: "Proteção contra Surtos", description: "Proteção SPD integrada", color: "orange" },
          ]
        },
        {
          id: "cooling", title: "Sistema de Refrigeração", description: "Controle térmico do equipamento", color: "orange", icon: "thermostat", // Thermometer -> thermostat
          children: [
            { id: "fans", title: "Ventiladores Inteligentes", description: "Controle dinâmico baseado em temperatura", color: "orange" },
            { id: "airflow", title: "Fluxo de Ar Otimizado", description: "Design front-to-back airflow", color: "orange" },
            { id: "temp-sensors", title: "Sensores de Temperatura", description: "Monitoramento em tempo real", color: "cyan" },
          ]
        }
      ]
    },
    {
      id: "functions", title: "Funções Principais", description: "Funcionalidades core da BBU", color: "green", icon: "memory", // Cpu -> memory
      children: [
        {
          id: "baseband", title: "Processamento Banda Base", description: "Funções de camada física e processamento de sinal", color: "green", icon: "graphic_eq", // Activity -> graphic_eq
          children: [
            { id: "modulation", title: "Modulação/Demodulação", description: "QPSK, 16QAM, 64QAM, 256QAM", color: "green" },
            { id: "coding", title: "Codificação de Canal", description: "Turbo coding, LDPC para 5G NR", color: "green" },
            { id: "mimo", title: "Processamento MIMO", description: "Massive MIMO até 64T64R", color: "cyan" },
            { id: "beamforming", title: "Beamforming", description: "Formação de feixes dinâmica", color: "cyan" },
          ]
        },
        {
          id: "protocol", title: "Processamento de Protocolo", description: "Camadas 2 e 3 do stack de protocolo", color: "purple", icon: "lan", // Network -> lan
          children: [
            { id: "mac", title: "Camada MAC", description: "Scheduling, HARQ, controle de recursos", color: "purple" },
            { id: "rlc", title: "Camada RLC", description: "Segmentação, retransmissão ARQ", color: "purple" },
            { id: "pdcp", title: "Camada PDCP", description: "Criptografia, compressão de cabeçalho", color: "purple" },
            { id: "rrc", title: "Camada RRC", description: "Gerenciamento de conexão, handover", color: "purple" },
          ]
        },
        {
          id: "sync", title: "Sincronização", description: "Timing e sincronização de rede", color: "cyan", icon: "schedule", // Clock -> schedule
          children: [
            { id: "gps", title: "Sincronização GPS/GNSS", description: "Timing absoluto via satélite", color: "cyan" },
            { id: "1588", title: "IEEE 1588v2 PTP", description: "Precisão Time Protocol", color: "cyan" },
            { id: "synce", title: "SyncE", description: "Synchronous Ethernet", color: "blue" },
          ]
        }
      ]
    },
    {
      id: "technologies", title: "Tecnologias Suportadas", description: "Padrões e tecnologias de rádio", color: "purple", icon: "radio", // Radio -> radio
      children: [
        {
          id: "lte", title: "LTE / LTE-Advanced", description: "4G e evoluções", color: "blue", icon: "wifi", // Wifi -> wifi
          children: [
            { id: "fdd-lte", title: "FDD-LTE", description: "Bandas pareadas (1, 3, 7, etc.)", color: "blue" },
            { id: "tdd-lte", title: "TDD-LTE", description: "Bandas não pareadas (38, 40, 41)", color: "blue" },
            { id: "ca", title: "Carrier Aggregation", description: "Agregação de portadoras até 5CC", color: "cyan" },
            { id: "laa", title: "LAA/eLAA", description: "Licensed Assisted Access", color: "purple" },
          ]
        },
        {
          id: "nr", title: "5G NR (New Radio)", description: "Tecnologia 5G standalone e non-standalone", color: "green", icon: "public", // Globe -> public
          children: [
            { id: "nsa", title: "NSA (Non-Standalone)", description: "Âncora LTE + 5G NR", color: "green" },
            { id: "sa", title: "SA (Standalone)", description: "5G core nativo", color: "green" },
            { id: "fr1", title: "FR1 (Sub-6 GHz)", description: "Frequências abaixo de 6 GHz", color: "cyan" },
            { id: "dss", title: "DSS (Dynamic Spectrum Sharing)", description: "Compartilhamento dinâmico LTE/NR", color: "purple" },
          ]
        },
        {
          id: "legacy", title: "Tecnologias Legadas", description: "Suporte a gerações anteriores", color: "orange",
          children: [
            { id: "umts", title: "UMTS/HSPA+", description: "3G WCDMA", color: "orange" },
            { id: "gsm", title: "GSM/EDGE", description: "2G (via SDR)", color: "orange" },
          ]
        }
      ]
    },
    {
      id: "management", title: "Gerenciamento (O&M)", description: "Operação e manutenção", color: "orange", icon: "build", // Settings -> build
      children: [
        {
          id: "nms", title: "Sistema de Gerência", description: "Ferramentas de gestão centralizada", color: "orange", icon: "storage", // Database -> storage
          children: [
            { id: "ums", title: "U2000/iManager", description: "Sistema de gerência unificado Huawei", color: "orange" },
            { id: "lmt", title: "LMT (Local Maintenance Terminal)", description: "Manutenção local via CLI/Web", color: "orange" },
            { id: "mml", title: "Comandos MML", description: "Man-Machine Language para configuração", color: "cyan" },
          ]
        },
        {
          id: "monitoring", title: "Monitoramento", description: "Indicadores e alarmes", color: "cyan", icon: "speed", // Gauge -> speed
          children: [
            { id: "kpis", title: "KPIs de Performance", description: "Throughput, latência, disponibilidade", color: "green" },
            { id: "alarms", title: "Sistema de Alarmes", description: "Alarmes críticos, major, minor, warning", color: "orange" },
            { id: "logs", title: "Logs e Traces", description: "Registros para troubleshooting", color: "blue" },
          ]
        },
        {
          id: "security", title: "Segurança", description: "Proteção e controle de acesso", color: "purple", icon: "lock", // Lock -> lock
          children: [
            { id: "auth", title: "Autenticação", description: "RADIUS, LDAP, local users", color: "purple" },
            { id: "encryption", title: "Criptografia", description: "IPSec para backhaul seguro", color: "purple" },
            { id: "firewall", title: "Firewall Integrado", description: "ACLs e filtros de pacotes", color: "orange" },
          ]
        }
      ]
    },
    {
      id: "deployment", title: "Deployment & Instalação", description: "Montagem e comissionamento", color: "cyan", icon: "save", // HardDrive -> save
      children: [
        {
          id: "installation", title: "Instalação Física", description: "Montagem do equipamento", color: "blue",
          children: [
            { id: "rack", title: "Montagem em Rack 19\"", description: "4U de altura padrão", color: "blue" },
            { id: "cabling", title: "Cabeamento", description: "Fibras ópticas e cabos de energia", color: "blue" },
            { id: "grounding", title: "Aterramento", description: "PGND e proteção", color: "green" },
          ]
        },
        {
          id: "commissioning", title: "Comissionamento", description: "Ativação e configuração inicial", color: "green", icon: "check_circle", // CheckCircle -> check_circle
          children: [
            { id: "initial-config", title: "Configuração Inicial", description: "IP, transporte, parâmetros básicos", color: "green" },
            { id: "integration", title: "Integração de Células", description: "Adição de RRUs e setores", color: "cyan" },
            { id: "testing", title: "Testes de Aceitação", description: "Drive test, KPI verification", color: "purple" },
          ]
        },
        {
          id: "maintenance", title: "Manutenção", description: "Procedimentos de manutenção", color: "orange", icon: "autorenew", // RefreshCw -> autorenew
          children: [
            { id: "sw-upgrade", title: "Upgrade de Software", description: "Atualização de firmware BBU", color: "orange" },
            { id: "board-replace", title: "Substituição de Placas", description: "Hot-swap quando suportado", color: "orange" },
            { id: "backup", title: "Backup & Restore", description: "Backup de configuração", color: "cyan" },
          ]
        }
      ]
    },
    {
      id: "integration", title: "Integração de Rede", description: "Conexões com outros elementos", color: "blue", icon: "public", // Globe -> public
      children: [
        {
          id: "fronthaul", title: "Fronthaul", description: "Conexão BBU ↔ RRU", color: "cyan",
          children: [
            { id: "rru-types", title: "Tipos de RRU", description: "AAU, pRRU, RRU variantes", color: "cyan" },
            { id: "fiber", title: "Fibras Ópticas", description: "Single-mode, multi-mode", color: "blue" },
            { id: "split", title: "Functional Split", description: "Opções de divisão 7.2, 8", color: "purple" },
          ]
        },
        {
          id: "backhaul", title: "Backhaul", description: "Conexão com core network", color: "green",
          children: [
            { id: "s1", title: "Interface S1/NG", description: "Conexão com MME/AMF", color: "green" },
            { id: "x2", title: "Interface X2/Xn", description: "Conexão inter-eNB/gNB", color: "green" },
            { id: "transport", title: "Rede de Transporte", description: "IP/MPLS, PTN", color: "blue" },
          ]
        }
      ]
    }
  ]
};

var mindMapRendered = false;

// 1. Função chamada pelo botão no Header
function toggleMindMap() {
    var modal = document.getElementById('mindMapModal');
    var container = document.getElementById('mindMapContainer');
    
    if (modal.style.display === 'none') {
        modal.style.display = 'flex';
        if (!mindMapRendered) {
            container.innerHTML = '';
            // Renderiza o nó raiz e seus filhos
            renderNeonNode(BBU_FULL_DATA, container, true);
            mindMapRendered = true;
        }
    } else {
        modal.style.display = 'none';
    }
}

// 2. Função Recursiva de Renderização (Estilo Neon/React)
function renderNeonNode(node, parentElement, isRoot = false) {
    // Wrapper para identação (se não for raiz)
    var wrapper = document.createElement('div');
    wrapper.className = isRoot ? '' : 'mm-node-wrapper';

    // Se não for raiz, desenha a linha conectora vertical
    
    // --- CRIAÇÃO DO CARD (O NÓ) ---
    var card = document.createElement('div');
    // Adiciona as classes de estilo baseado na cor (definido no CSS)
    card.className = `mm-card style-${node.color || 'cyan'}`;
    
    // Configura clique para expandir/fechar
    var hasChildren = node.children && node.children.length > 0;
    if (hasChildren) {
        card.onclick = function(e) {
            e.stopPropagation();
            // Alterna classe 'expanded' no card (gira a seta)
            card.classList.toggle('expanded');
            // Acha o container de filhos logo abaixo e alterna 'open'
            var childContainer = wrapper.querySelector('.mm-children-container');
            if(childContainer) childContainer.classList.toggle('open');
        };
    } else {
        card.style.cursor = "default";
    }

    // --- CONTEÚDO DO CARD ---
    // 1. Dot brilhante
    var dot = document.createElement('div');
    dot.className = `mm-dot dot-${node.color || 'cyan'}`;
    card.appendChild(dot);

    // 2. Ícone (se houver)
    if (node.icon) {
        var iconEl = document.createElement('span');
        iconEl.className = 'material-icons mm-icon';
        iconEl.innerText = node.icon;
        card.appendChild(iconEl);
    }

    // 3. Textos
    var textDiv = document.createElement('div');
    textDiv.style.flex = "1";
    textDiv.innerHTML = `
        <div class="mm-title">${node.title}</div>
        ${node.description ? `<div class="mm-desc">${node.description}</div>` : ''}
    `;
    card.appendChild(textDiv);

    // 4. Seta (Chevron) se tiver filhos
    if (hasChildren) {
        var chevron = document.createElement('span');
        chevron.className = 'material-icons mm-chevron';
        chevron.innerText = 'expand_more';
        card.appendChild(chevron);
    }

    wrapper.appendChild(card);

    // --- FILHOS (RECURSÃO) ---
    if (hasChildren) {
        var childrenContainer = document.createElement('div');
        childrenContainer.className = 'mm-children-container';
        // Se for o nó raiz, já começa aberto para o usuário ver as categorias principais
        if(isRoot) childrenContainer.classList.add('open');
        
        node.children.forEach(childNode => {
            renderNeonNode(childNode, childrenContainer, false);
        });
        
        wrapper.appendChild(childrenContainer);
    }

    parentElement.appendChild(wrapper);
}

// === Painel Lateral de Configuração RF (Off-Canvas) ===
function abrirPainelGeral() {
    try {
        var panel = document.getElementById('sideConfigPanel');
        var sel = document.getElementById('panelCableSelector');
        sel.innerHTML = '';
        // Filtrar apenas cabos LOCAL e REMOTE (não UMPT, GPS, DCDU)
        var cables = cableManager.getAllCables().filter(c => c.sourceType === 'LOCAL' || c.sourceType === 'REMOTE');
        if(cables.length === 0) {
            sel.innerHTML = '<option value="">-- Nenhum --</option>';
            var infoEl = document.getElementById('panelInfoSourceType'); if(infoEl) infoEl.innerText = 'TIPO: ...';
        } else {
            cables.forEach(function(c, idx) {
                var opt = document.createElement('option'); opt.value = c.id;
                opt.text = (c.siteOrigin || c.sourceType) + ' -> ' + (c.connectedTo || 'Slot 0 Port 1');
                sel.appendChild(opt);
            });
            sel.value = cables[0].id;
            trocarCaboPainel(sel.value);
        }
        panel.classList.add('open');
    } catch (err) { console.error('abrirPainelGeral:', err); }
}

function abrirPainelConfig(id) {
    try {
        var panel = document.getElementById('sideConfigPanel');
        var sel = document.getElementById('panelCableSelector');
        sel.innerHTML = '';
        // Filtrar apenas cabos LOCAL e REMOTE (não UMPT, GPS, DCDU)
        var cables = cableManager.getAllCables().filter(c => c.sourceType === 'LOCAL' || c.sourceType === 'REMOTE');
        cables.forEach(function(c) {
            var opt = document.createElement('option'); opt.value = c.id;
            opt.text = (c.siteOrigin || c.sourceType) + ' -> ' + (c.connectedTo || 'Slot 0 Port 1');
            sel.appendChild(opt);
        });
        // seleciona o id pedido
        if (id && sel.querySelector('option[value="' + id + '"]')) sel.value = id;
        if (!sel.value && sel.options.length>0) sel.selectedIndex = 0;
        trocarCaboPainel(sel.value);
        panel.classList.add('open');
    } catch (err) { console.error('abrirPainelConfig:', err); }
}

function trocarCaboPainel(id) {
    try {
        if(!id) return;
        var cable = cableManager.getAllCables().find(c => c.id === id);
        if(!cable) return;
        var infoEl = document.getElementById('panelInfoSourceType'); if(infoEl) infoEl.innerText = 'TIPO: ' + (cable.sourceType || 'UNKNOWN') + (cable.siteOrigin ? ' • ' + cable.siteOrigin : '');
        // Preencher inputs
        var cfg = cable.config || {};
        var sEl = document.getElementById('panelCfgSetor'); if(sEl) sEl.value = cfg.sector || '';
        var lteEl = document.getElementById('panelCfgLteCount'); if(lteEl) lteEl.value = (typeof cfg.lteCount !== 'undefined' ? String(cfg.lteCount) : (cfg.lte || 0));
        var nrEl = document.getElementById('panelCfgNrBw'); if(nrEl) nrEl.value = (cfg.nrBw || 0);
        var rEl = document.getElementById('panelCfgRadio'); if(rEl) rEl.value = (cfg.radio || (rEl.options && rEl.options[0] ? rEl.options[0].value : ''));
    } catch (err) { console.error('trocarCaboPainel:', err); }
}

function salvarConfigPainel() {
    try {
        var sel = document.getElementById('panelCableSelector');
        var id = sel.value;
        if(!id) return showNotification('Nenhum cabo selecionado.', 'warning');
        var cable = cableManager.getAllCables().find(c => c.id === id);
        if(!cable) return showNotification('Cabo não encontrado.', 'error');

        var sectorEl = document.getElementById('panelCfgSetor'); var sector = sectorEl ? sectorEl.value : '';
        if(!sector) return showNotification('Setor é obrigatório.', 'error');

        var lteCountEl = document.getElementById('panelCfgLteCount'); var lteCount = parseInt((lteCountEl ? lteCountEl.value : '0') || '0');
        var nrBwEl = document.getElementById('panelCfgNrBw'); var nrBw = parseInt((nrBwEl ? nrBwEl.value : '0') || '0');
        var radioEl = document.getElementById('panelCfgRadio'); var radio = radioEl ? radioEl.value : null;

        cable.config = cable.config || {};
        cable.config.sector = sector;
        cable.config.lteCount = lteCount;
        cable.config.nrBw = nrBw;
        cable.config.radio = radio;

        // Atualiza visual e recalcula capacidade
        cableManager.render();
        if (typeof validarCapacidadeBBU === 'function') validarCapacidadeBBU();
        if (typeof atualizarPowerBudget === 'function') atualizarPowerBudget();

        showNotification('Configuração salva.', 'success');
    } catch (err) { console.error('salvarConfigPainel:', err); showNotification('Erro ao salvar configuração.', 'error'); }
}

function deletarCaboPeloPainel() {
    try {
        var sel = document.getElementById('panelCableSelector');
        var id = sel.value;
        if(!id) return showNotification('Nenhum cabo selecionado.', 'warning');
        var idx = cableManager.cables.findIndex(c => c.id === id);
        if(idx === -1) return showNotification('Cabo não encontrado.', 'error');

        cableManager.cables.splice(idx, 1);
        cableManager.render();
        showNotification('Cabo removido.', 'success');

        // Atualiza lista e seleciona próximo
        var selEl = document.getElementById('panelCableSelector');
        var next = selEl.options[selEl.selectedIndex] && selEl.options[selEl.selectedIndex+1] ? selEl.options[selEl.selectedIndex+1].value : (selEl.options[0] ? selEl.options[0].value : '');
        abrirPainelGeral();
        if(next) {
            selEl.value = next; trocarCaboPainel(next);
        } else {
            document.getElementById('sideConfigPanel').classList.remove('open');
        }
    } catch (err) { console.error('deletarCaboPeloPainel:', err); showNotification('Erro ao deletar cabo.', 'error'); }
}

// Alias para compatibilidade com chamadas antigas
function abrirConfigCabo(id) { abrirPainelConfig(id); }

// Hook: troca no select do painel (attach immediately)
var __panelSel = document.getElementById('panelCableSelector');
if(__panelSel) __panelSel.addEventListener('change', function() { trocarCaboPainel(this.value); });
