// =========================================================================
// MONITOR EXCLUSIVO DE COCINA (KDS) - TOSTADERIA LA CRUDITA
// =========================================================================
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbysr4bbuBKbkaTNRYuUpe4P1OsuC_qpLAebi-_r_C0NPG9VJwIc4MKbHtmcGh158cBYYQ/exec";

let kdsTickets = JSON.parse(localStorage.getItem("crudita_kds")) || [];
let currentFilter = "Todos";
let soundOn = true;
let knownTicketIds = new Set(kdsTickets.map(t => String(t.id)));

// Registro de cambios recientes para evitar que pullFromCloud() pise un estado recién cambiado
const pendingStatusLocks = new Map(); // ticketId -> { status, expiresAt }
let isPulling = false;

function saveLocalTickets() {
    localStorage.setItem("crudita_kds", JSON.stringify(kdsTickets));
}

document.addEventListener("DOMContentLoaded", () => {
    renderKDS();
    pullFromCloud();

    // Sincronización automática cada 5 segundos + actualización de relojes cada 30s
    setInterval(pullFromCloud, 5000);
    setInterval(renderKDS, 30000);

    // Sincronización instantánea si se abre en el mismo navegador que POS o Meseros
    window.addEventListener("storage", (e) => {
        if (e.key === "crudita_kds") {
            const localData = JSON.parse(localStorage.getItem("crudita_kds")) || [];
            kdsTickets = mergeWithLocalLocks(localData);
            renderKDS();
        }
    });
});

function setKdsFilter(filter, btn) {
    currentFilter = filter;
    document.querySelectorAll(".filter-chips .chip").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    renderKDS();
}

function toggleSound() {
    soundOn = !soundOn;
    const btn = document.getElementById("sound-toggle-btn");
    btn.classList.toggle("active", soundOn);
    btn.innerHTML = soundOn ? `<i class="fa-solid fa-volume-high"></i>` : `<i class="fa-solid fa-volume-xmark"></i>`;
}

function playBeep() {
    if (!soundOn) return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(780, ctx.currentTime);
        osc.frequency.setValueAtTime(1040, ctx.currentTime + 0.14);
        gain.gain.setValueAtTime(0.22, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.45);
    } catch (e) {}
}

function getElapsedMinutes(iso) {
    if (!iso) return 0;
    return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

function renderKDS() {
    const active = kdsTickets.filter(t => t.status !== "Entregado");
    const pend = active.filter(t => t.status === "Pendiente").length;
    const prep = active.filter(t => t.status === "Preparando").length;
    const listo = active.filter(t => t.status === "Listo").length;

    document.getElementById("nav-kds-count").innerText = active.length;
    document.getElementById("cnt-pend").innerText = pend;
    document.getElementById("cnt-prep").innerText = prep;
    document.getElementById("cnt-listo").innerText = listo;

    const visible = currentFilter === "Todos" ? active : active.filter(t => t.status === currentFilter);
    const board = document.getElementById("kds-board");

    if (visible.length === 0) {
        board.innerHTML = `<p style="color:var(--text-muted); padding:20px;">Sin comandas pendientes en esta vista.</p>`;
        return;
    }

    board.innerHTML = visible.map(t => {
        const mins = getElapsedMinutes(t.createdAt);
        let btnHtml = "";
        if (t.status === "Pendiente") {
            btnHtml = `<button class="btn-ticket-action" style="background:var(--warning); color:#0f172a;" onclick="changeTicketStatus('${t.id}', 'Preparando')"><i class="fa-solid fa-fire"></i> Empezar a Preparar</button>`;
        } else if (t.status === "Preparando") {
            btnHtml = `<button class="btn-ticket-action" style="background:var(--success);" onclick="changeTicketStatus('${t.id}', 'Listo')"><i class="fa-solid fa-bell"></i> Marcar Platillo Listo</button>`;
        } else {
            btnHtml = `<button class="btn-ticket-action" style="background:var(--secondary);" onclick="changeTicketStatus('${t.id}', 'Entregado')"><i class="fa-solid fa-check-double"></i> Confirmar Entregado</button>`;
        }

        const itemsArr = Array.isArray(t.items) ? t.items : [];
        return `
            <div class="ticket-card st-${t.status}">
                <div class="ticket-head">
                    <div>
                        <div>${t.reference}</div>
                        <small style="font-weight:500; opacity:0.9;">${t.source} • ${t.waiter}</small>
                    </div>
                    <span><i class="fa-regular fa-clock"></i> ${mins}m</span>
                </div>
                <div class="ticket-body">
                    ${itemsArr.map(i => `
                        <div class="t-item">
                            <strong>${i.qty}x ${i.name}</strong>
                            ${i.note ? `<span class="t-note"><i class="fa-solid fa-triangle-exclamation"></i> ${i.note}</span>` : ''}
                        </div>
                    `).join("")}
                </div>
                <div class="ticket-foot">${btnHtml}</div>
            </div>
        `;
    }).join("");
}

function changeTicketStatus(ticketId, newStatus) {
    const idStr = String(ticketId);
    const idx = kdsTickets.findIndex(t => String(t.id) === idStr);
    if (idx === -1) return;

    // 1. Actualizar inmediatamente en pantalla y bloquear lecturas viejas por 10 segundos
    kdsTickets[idx].status = newStatus;
    pendingStatusLocks.set(idStr, {
        status: newStatus,
        expiresAt: Date.now() + 10000
    });

    saveLocalTickets();
    renderKDS();

    // 2. Enviar cambio a Google Sheets
    pushToCloud("actualizarEstadoKDS", { id: idStr, status: newStatus });
}

function mergeWithLocalLocks(incomingTickets) {
    const now = Date.now();
    // Limpiar bloqueos expirados
    for (const [id, lock] of pendingStatusLocks.entries()) {
        if (now > lock.expiresAt) {
            pendingStatusLocks.delete(id);
        }
    }

    return incomingTickets.map(ticket => {
        const idStr = String(ticket.id);
        const lock = pendingStatusLocks.get(idStr);
        if (lock) {
            // Si la nube ya refleja el nuevo estado, liberamos el bloqueo
            if (ticket.status === lock.status) {
                pendingStatusLocks.delete(idStr);
                return ticket;
            }
            // Si la nube aún trae el estado viejo, conservamos el cambio local
            return { ...ticket, status: lock.status };
        }
        return ticket;
    });
}

async function pushToCloud(action, payload) {
    if (!GOOGLE_SCRIPT_URL) return;
    try {
        await fetch(GOOGLE_SCRIPT_URL, {
            method: "POST",
            mode: "no-cors",
            keepalive: true,
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ action, payload })
        });
    } catch (err) {
        console.error("Error enviando estado KDS:", err);
    }
}

async function pullFromCloud() {
    if (!GOOGLE_SCRIPT_URL || isPulling) return;
    isPulling = true;
    const indicator = document.getElementById("kds-sync-indicator");

    try {
        const res = await fetch(`${GOOGLE_SCRIPT_URL}?action=getEstadoCompleto&t=${Date.now()}`);
        const data = await res.json();
        if (data.status === "ok" && Array.isArray(data.kdsTickets)) {
            const merged = mergeWithLocalLocks(data.kdsTickets);
            const hasNew = merged.some(t => !knownTicketIds.has(String(t.id)) && t.status === "Pendiente");
            merged.forEach(t => knownTicketIds.add(String(t.id)));

            kdsTickets = merged;
            if (hasNew) playBeep();

            saveLocalTickets();
            renderKDS();
            indicator.innerHTML = `<i class="fa-solid fa-wifi"></i> Cocina en línea (${new Date().toLocaleTimeString("es-MX", { hour: '2-digit', minute: '2-digit', second: '2-digit' })})`;
        }
    } catch (err) {
        indicator.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Modo Local`;
    } finally {
        isPulling = false;
    }
}

function manualSync() {
    pullFromCloud();
}