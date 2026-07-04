// =============================================================
// BACKUP STOCK MANAGEMENT SYSTEM — backup_stock.js
// =============================================================

let db = null;
let allBackupStocks = [];   // Merged data: sku_master + production_backup_stock
let allLogs = [];
let pendingApprovalOrders = [];
let sortField = 'product_code';
let sortAsc = true;
let showOnlyLow = false;
let searchQuery = '';
let activeTab = 'stock';
let currentEditProduct = null; // { product_code, product_name, quantity, reorder_point, unit }
let adjustMode = 'receive';    // 'receive' | 'issue'
let realtimeChannel = null;
let currentUserSession = null;

// ─── INIT ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    db = (window.auth && window.auth.supabase)
        ? window.auth.supabase
        : (window.supabase && window.SUPABASE_CONFIG
            ? window.supabase.createClient(window.SUPABASE_CONFIG.URL, window.SUPABASE_CONFIG.KEY)
            : null);

    if (!db) {
        showToast('❌ ไม่สามารถเชื่อมต่อฐานข้อมูลได้ — ตรวจสอบ config.js', 'error');
        return;
    }

    // Get session for user id
    try {
        const { data: { session } } = await db.auth.getSession();
        currentUserSession = session;
    } catch(e) {
        console.warn('Could not get session:', e);
    }

    document.getElementById('adjustForm').addEventListener('submit', handleAdjustSubmit);
    await refreshBackupStockList();
    await refreshApprovalOrders();
    await loadMovementLogs();
    setupRealtime();
});

// ─── TOAST ─────────────────────────────────────────────────────
function showToast(msg, type = 'success') {
    const el = document.getElementById('toast');
    if (!el) return;
    const colors = {
        success: '#10b981',
        error: '#f87171',
        info: '#818cf8',
        warning: '#f59e0b'
    };
    el.style.background = 'rgba(15,23,42,0.97)';
    el.style.borderColor = colors[type] || colors.info;
    el.style.color = colors[type] || colors.info;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), 3800);
}

// ─── REALTIME ──────────────────────────────────────────────────
function setupRealtime() {
    if (!db) return;
    realtimeChannel = db.channel('backup-stock-realtime')
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'production_backup_stock'
        }, payload => {
            const { eventType, new: nw, old: oldRow } = payload;

            if (eventType === 'UPDATE' || eventType === 'INSERT') {
                const idx = allBackupStocks.findIndex(s => s.product_code === nw.product_code);
                if (idx !== -1) {
                    allBackupStocks[idx] = { ...allBackupStocks[idx], ...nw };
                } else {
                    allBackupStocks.push({
                        product_code: nw.product_code,
                        product_name: nw.product_name || nw.product_code,
                        product_size: nw.product_size || '',
                        quantity: nw.quantity ?? 0,
                        reorder_point: nw.reorder_point ?? 2,
                        unit: nw.unit || 'ชิ้น',
                        updated_at: nw.updated_at || null
                    });
                }
                if (!updateBackupStockRowInDOM(nw)) {
                    renderBackupStockTable();
                    loadSkuDetailsForBackupRow(nw.product_code);
                }
                updateStats();
                refreshApprovalOrders();
            } else if (eventType === 'DELETE' && oldRow && oldRow.product_code) {
                allBackupStocks = allBackupStocks.filter(s => s.product_code !== oldRow.product_code);
                const row = document.querySelector(`#stockTableBody tr[data-code="${CSS.escape(oldRow.product_code)}"]`);
                if (row) row.remove();
                updateStats();
                refreshApprovalOrders();
                const empty = document.getElementById('emptyState');
                if (empty && document.querySelectorAll('#stockTableBody tr').length === 0) {
                    empty.style.display = 'block';
                }
            }
        })
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'production_backup_stock_log'
        }, payload => {
            allLogs.unshift(payload.new);
            renderLogs();
        })
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'stock_orders'
        }, payload => {
            const { eventType, new: nw } = payload;
            if (!nw) return;
            const hasUntracked = !nw.tracking_number || nw.tracking_number === '-' || nw.tracking_number === '';
            if (eventType === 'INSERT' || eventType === 'UPDATE') {
                if (hasUntracked && ['รอดำเนินการ','กำลังผลิต','ผลิตสำเร็จแล้ว'].includes(nw.tracking_status)) {
                    refreshApprovalOrders();
                } else {
                    refreshApprovalOrders();
                }
            } else if (eventType === 'DELETE') {
                refreshApprovalOrders();
            }
        })
        .subscribe();
}

function updateBackupStockRowInDOM(stock) {
    const productCode = stock.product_code;
    if (!productCode) return false;

    const row = document.querySelector(`#stockTableBody tr[data-code="${CSS.escape(productCode)}"]`);
    if (!row) return false;

    const existingIndex = allBackupStocks.findIndex(s => s.product_code === productCode);
    const mergedStock = existingIndex !== -1 ? allBackupStocks[existingIndex] : {
        product_code: stock.product_code,
        product_name: stock.product_name || stock.product_code,
        product_size: stock.product_size || '',
        quantity: stock.quantity ?? 0,
        reorder_point: stock.reorder_point ?? 2,
        unit: stock.unit || 'ชิ้น',
        updated_at: stock.updated_at || null
    };

    const isLow = mergedStock.quantity <= mergedStock.reorder_point;
    const qtyClass = isLow ? 'qty-low' : 'qty-ok';
    const badge = isLow
        ? `<span class="badge-low">⚠️ ต่ำ</span>`
        : `<span class="badge-ok">✅ ปกติ</span>`;

    const quantityCell = row.querySelector('.qty-value');
    if (quantityCell) {
        quantityCell.textContent = (mergedStock.quantity ?? 0).toLocaleString('th-TH');
        quantityCell.className = `qty-value ${qtyClass}`;
    }

    const unitCell = row.children[3];
    if (unitCell) unitCell.innerHTML = esc(mergedStock.unit || 'ชิ้น');

    const sizeCell = row.children[4];
    if (sizeCell) {
        sizeCell.innerHTML = mergedStock.product_size
            ? `<span style="background:rgba(168,85,247,0.12);color:#c084fc;padding:2px 8px;border-radius:20px;font-size:0.8rem;">${esc(mergedStock.product_size)}</span>`
            : '<span style="color:var(--muted);">-</span>';
    }

    const reorderCell = row.children[5];
    if (reorderCell) reorderCell.innerHTML = `<span style="color: var(--muted); font-size:0.88rem;">${mergedStock.reorder_point ?? 2}</span>`;

    const badgeCell = row.children[7];
    if (badgeCell) badgeCell.innerHTML = badge;

    row.classList.toggle('row-low', isLow);

    if (!mergedStock.product_size) {
        loadSkuDetailsForBackupRow(productCode);
    }

    return true;
}

async function loadSkuDetailsForBackupRow(productCode) {
    if (!productCode || !db) return;
    const row = document.querySelector(`#stockTableBody tr[data-code="${CSS.escape(productCode)}"]`);
    if (!row) return;

    const existingIndex = allBackupStocks.findIndex(s => s.product_code === productCode);
    if (existingIndex !== -1 && allBackupStocks[existingIndex].product_size) return;

    const { data: sku, error } = await db
        .from('sku_master')
        .select('name, size')
        .eq('product_code', productCode)
        .limit(1)
        .single();

    if (error || !sku) return;

    if (existingIndex !== -1) {
        allBackupStocks[existingIndex].product_name = sku.name || allBackupStocks[existingIndex].product_name;
        allBackupStocks[existingIndex].product_size = sku.size || allBackupStocks[existingIndex].product_size;
    }

    const productNameCell = row.querySelector('.product-name');
    if (productNameCell && sku.name) {
        productNameCell.textContent = sku.name;
    }

    const sizeCell = row.children[4];
    if (sizeCell) {
        sizeCell.innerHTML = sku.size
            ? `<span style="background:rgba(168,85,247,0.12);color:#c084fc;padding:2px 8px;border-radius:20px;font-size:0.8rem;">${esc(sku.size)}</span>`
            : '<span style="color:var(--muted);">-</span>';
    }
}

// ─── DATA LOADING ───────────────────────────────────────────────
async function refreshBackupStockList() {
    try {
        // Load backup stock quantities first
        const { data: backups, error: bkErr } = await db
            .from('production_backup_stock')
            .select('product_code, quantity, reorder_point, unit, updated_at')
            .gt('quantity', 0)
            .order('product_code', { ascending: true });

        if (bkErr) throw bkErr;

        if (!backups || backups.length === 0) {
            allBackupStocks = [];
            renderBackupStockTable();
            updateStats();
            return;
        }

        const backupCodes = backups.map(b => b.product_code);

        const { data: skus, error: skuErr } = await db
            .from('sku_master')
            .select('product_code, name, size')
            .in('product_code', backupCodes);

        if (skuErr) throw skuErr;

        const skuMap = {};
        (skus || []).forEach(sku => {
            skuMap[sku.product_code] = sku;
        });

        allBackupStocks = (backups || []).map(b => {
            const sku = skuMap[b.product_code];
            return {
                product_code: b.product_code,
                product_name: sku?.name || b.product_code,
                product_size: sku?.size || '',
                quantity: b.quantity ?? 0,
                reorder_point: b.reorder_point ?? 2,
                unit: b.unit || 'ชิ้น',
                updated_at: b.updated_at || null
            };
        });

        renderBackupStockTable();
        updateStats();
    } catch (err) {
        console.error('Error loading backup stocks:', err);
        showToast('❌ โหลดข้อมูลล้มเหลว: ' + err.message, 'error');
    }
}

async function refreshApprovalOrders() {
    try {
        // Find pending orders without tracking_number that still have available backup stock
        const { data: orders, error } = await db
            .from('stock_orders')
            .select('id, order_number, product_code, product_name, quantity, tracking_status, stock_deducted')
            .or('tracking_number.is.null,tracking_number.eq.-,tracking_number.eq.')
            .in('tracking_status', ['รอดำเนินการ', 'กำลังผลิต'])
            .order('order_number', { ascending: true });

        if (error) throw error;

        const orderList = orders || [];
        const backupCodes = [...new Set(orderList.map(o => o.product_code).filter(Boolean))];

        if (!backupCodes.length) {
            pendingApprovalOrders = [];
            renderApprovalOrders();
            return;
        }

        const { data: backupStocks, error: backupError } = await db
            .from('production_backup_stock')
            .select('product_code, quantity')
            .in('product_code', backupCodes)
            .gt('quantity', 0);

        if (backupError) throw backupError;
        const backupMap = (backupStocks || []).reduce((acc, item) => {
            acc[item.product_code] = item.quantity;
            return acc;
        }, {});

        pendingApprovalOrders = orderList
            .map(o => ({
                ...o,
                quantity: Number(o.quantity) || 0,
                backup_quantity: Number(backupMap[o.product_code] ?? 0)
            }))
            .filter(o => o.product_code && o.backup_quantity >= o.quantity && o.quantity > 0)
            .sort((a, b) => String(a.order_number || '').localeCompare(String(b.order_number || '')));

        renderApprovalOrders();
    } catch (err) {
        console.error('Error loading approval orders:', err);
    }
}

function renderApprovalOrders() {
    const tbody = document.getElementById('pendingOrdersBody');
    if (!tbody) return;

    if (!pendingApprovalOrders.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align:center; padding:2rem; color:#64748b;">
                    ไม่มีออเดอร์ที่ยังไม่มีเลขพัสดุและมีสต็อกสำรองเพียงพอสำหรับอนุมัติ
                </td>
            </tr>`;
        return;
    }

    tbody.innerHTML = pendingApprovalOrders.map(order => {
        const statusBadge = order.tracking_status === 'รอดำเนินการ'
            ? '<span class="badge badge-pending">⏳ รอผลิต</span>'
            : '<span class="badge badge-producing">🔨 กำลังผลิต</span>';

        return `
            <tr>
                <td>${esc(order.order_number || '-')}</td>
                <td>${esc(order.product_code || '-')}</td>
                <td>${esc(order.product_name || '-')}</td>
                <td style="text-align:right;">${order.quantity}</td>
                <td style="text-align:right;">${order.backup_quantity}</td>
                <td>${statusBadge}</td>
                <td>
                    <button class="btn-approve" onclick="approveOrderFromBackup('${order.id}')">
                        ✅ อนุมัติใช้สต็อกสำรอง
                    </button>
                </td>
            </tr>`;
    }).join('');
}

async function approveOrderFromBackup(orderId) {
    const order = pendingApprovalOrders.find(o => o.id === orderId);
    if (!order) {
        showToast('ไม่พบออเดอร์สำหรับอนุมัติ', 'error');
        return;
    }

    const confirmMsg = `คุณแน่ใจหรือไม่ว่าจะอนุมัติให้ออเดอร์ ${order.order_number || order.id} ใช้สต็อกสำรอง ${order.quantity} ชิ้น?`;
    if (!confirm(confirmMsg)) return;

    try {
        const operator = currentUserSession?.user?.email || 'admin';
        const { data, error } = await db.rpc('rpc_use_backup_stock_for_order', {
            p_order_id: order.id,
            p_operator: operator,
            p_user_id: currentUserSession?.user?.id || null
        });
        if (error) throw error;
        if (data?.status === 'error') throw new Error(data.message || 'RPC ล้มเหลว');

        showToast('✅ อนุมัติการใช้สต็อกสำรองเรียบร้อย', 'success');
        await refreshBackupStockList();
        await refreshApprovalOrders();
    } catch (err) {
        console.error('Approve error:', err);
        showToast('❌ อนุมัติไม่สำเร็จ: ' + err.message, 'error');
    }
}

async function loadMovementLogs() {
    try {
        const { data, error } = await db
            .from('production_backup_stock_log')
            .select('id, product_code, old_qty, new_qty, delta, operator, reason, created_at')
            .order('created_at', { ascending: false })
            .limit(300);

        if (error) throw error;
        allLogs = data || [];
        renderLogs();
    } catch (err) {
        console.error('Error loading logs:', err);
    }
}

// ─── STATS ─────────────────────────────────────────────────────
function updateStats() {
    const total = allBackupStocks.length;
    const low = allBackupStocks.filter(s => s.quantity <= s.reorder_point).length;
    const totalQty = allBackupStocks.reduce((acc, s) => acc + (parseInt(s.quantity) || 0), 0);

    document.getElementById('totalItems').textContent = total;
    document.getElementById('lowStockItems').textContent = low;
    document.getElementById('totalValue').textContent = totalQty.toLocaleString('th-TH');
}

// ─── SORT ───────────────────────────────────────────────────────
function sortBy(field) {
    if (sortField === field) {
        sortAsc = !sortAsc;
    } else {
        sortField = field;
        sortAsc = true;
    }
    renderBackupStockTable();
}

function getSorted(arr) {
    return [...arr].sort((a, b) => {
        let va = a[sortField], vb = b[sortField];
        if (typeof va === 'string') va = va.toLowerCase();
        if (typeof vb === 'string') vb = vb.toLowerCase();
        if (va < vb) return sortAsc ? -1 : 1;
        if (va > vb) return sortAsc ? 1 : -1;
        return 0;
    });
}

// ─── SEARCH / FILTER ───────────────────────────────────────────
function searchStocks() {
    searchQuery = (document.getElementById('searchInput')?.value || '').toLowerCase();
    renderBackupStockTable();
}

function toggleLowStockFilter(checked) {
    showOnlyLow = checked;
    const card = document.getElementById('lowStockCard');
    card?.classList.toggle('selected', checked);
    renderBackupStockTable();
}

function toggleLowStockFilterFromCard() {
    const cb = document.getElementById('lowStockCheckbox');
    if (!cb) return;
    cb.checked = !cb.checked;
    toggleLowStockFilter(cb.checked);
}

// ─── RENDER TABLE ───────────────────────────────────────────────
function renderBackupStockTable() {
    const tbody = document.getElementById('stockTableBody');
    const empty = document.getElementById('emptyState');
    if (!tbody) return;

    let items = getSorted(allBackupStocks);

    // Apply search filter
    if (searchQuery) {
        items = items.filter(s =>
            (s.product_code || '').toLowerCase().includes(searchQuery) ||
            (s.product_name || '').toLowerCase().includes(searchQuery)
        );
    }

    // Apply low stock filter
    if (showOnlyLow) {
        items = items.filter(s => s.quantity <= s.reorder_point);
    }

    if (!items.length) {
        tbody.innerHTML = '';
        if (empty) empty.style.display = 'block';
        return;
    }

    if (empty) empty.style.display = 'none';
    tbody.innerHTML = items.map(s => buildRow(s)).join('');
}

function esc(str) {
    const el = document.createElement('span');
    el.textContent = str ?? '';
    return el.innerHTML;
}

function buildRow(s) {
    const isLow = s.quantity <= s.reorder_point;
    const qtyClass = isLow ? 'qty-low' : 'qty-ok';
    const badge = isLow
        ? `<span class="badge-low">⚠️ ต่ำ</span>`
        : `<span class="badge-ok">✅ ปกติ</span>`;
    const rowClass = isLow ? 'row-low' : '';

    return `
    <tr class="${rowClass}" data-code="${esc(s.product_code)}">
        <td><span class="product-code">${esc(s.product_code)}</span></td>
        <td>
            <div class="product-name">${esc(s.product_name)}</div>
        </td>
        <td style="text-align: right; padding-right: 2rem;">
            <span class="qty-value ${qtyClass}">${(s.quantity ?? 0).toLocaleString('th-TH')}</span>
        </td>
        <td>${esc(s.unit || 'ชิ้น')}</td>
        <td>${s.product_size ? `<span style="background:rgba(168,85,247,0.12);color:#c084fc;padding:2px 8px;border-radius:20px;font-size:0.8rem;">${esc(s.product_size)}</span>` : '<span style="color:var(--muted);">-</span>'}</td>
        <td><span style="color: var(--muted); font-size:0.88rem;">${s.reorder_point ?? 2}</span></td>
        <td>
            <div class="action-btns">
                <button class="action-btn action-btn-edit" title="ปรับปรุงสต็อก" onclick="openAdjustModal('${esc(s.product_code)}')">
                    ✏️
                </button>
            </div>
        </td>
        <td>${badge}</td>
    </tr>`;
}

// ─── LOG RENDERING ──────────────────────────────────────────────
function renderLogs() {
    const tbody = document.getElementById('logsTableBody');
    if (!tbody) return;

    const query = (document.getElementById('logSearchInput')?.value || '').toLowerCase();
    let logs = allLogs;

    if (query) {
        logs = logs.filter(lg =>
            (lg.product_code || '').toLowerCase().includes(query) ||
            (lg.operator || '').toLowerCase().includes(query) ||
            (lg.reason || '').toLowerCase().includes(query)
        );
    }

    if (!logs.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--muted); padding:2rem;">ไม่พบประวัติที่ตรงกับเงื่อนไข</td></tr>`;
        return;
    }

    tbody.innerHTML = logs.map(lg => {
        const d = new Date(lg.created_at);
        const dateStr = d.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: '2-digit' });
        const timeStr = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
        const delta = lg.delta ?? (lg.new_qty - lg.old_qty);
        const isPlus = delta > 0;
        const deltaStr = isPlus
            ? `<span style="color:#34d399; font-weight:700;">+${delta}</span>`
            : `<span style="color:#f87171; font-weight:700;">${delta}</span>`;

        // Look up product name
        const sku = allBackupStocks.find(s => s.product_code === lg.product_code);
        const nameLine = sku ? `<div style="font-size:0.76rem;color:var(--muted);">${esc(sku.product_name)}</div>` : '';

        return `
        <tr>
            <td style="white-space:nowrap; color:var(--muted); font-size:0.82rem;">${dateStr} ${timeStr}</td>
            <td>
                <div style="font-family:monospace; font-size:0.82rem; color:var(--primary-bright);">${esc(lg.product_code)}</div>
                ${nameLine}
            </td>
            <td style="text-align:right; padding-right:1.5rem;">${deltaStr}</td>
            <td style="text-align:right; padding-right:1.5rem; font-weight:600;">${lg.new_qty}</td>
            <td><span style="background:rgba(255,255,255,0.04);border:1px solid var(--border);padding:2px 8px;border-radius:20px;font-size:0.8rem;">${esc(lg.operator || '-')}</span></td>
            <td style="max-width:260px; font-size:0.82rem; color:var(--muted);">${esc(lg.reason || '-')}</td>
        </tr>`;
    }).join('');
}

// ─── SECTION TAB SWITCHING ───────────────────────────────────────
function switchSectionTab(tab) {
    activeTab = tab;
    ['stock', 'logs'].forEach(t => {
        const btn = document.getElementById('tab-' + t);
        const panel = document.getElementById('panel-' + t);
        if (btn) btn.classList.toggle('active', t === tab);
        if (panel) panel.style.display = t === tab ? '' : 'none';
    });
    if (tab === 'logs') renderLogs();
}

// ─── ADJUST MODAL ───────────────────────────────────────────────
async function openAdjustModal(productCode) {
    const stock = allBackupStocks.find(s => s.product_code === productCode);
    if (!stock) {
        showToast('ไม่พบข้อมูลสินค้า', 'error');
        return;
    }

    currentEditProduct = stock;
    adjustMode = 'receive';

    document.getElementById('modalProductCode').value = stock.product_code;
    document.getElementById('modalProductName').value = stock.product_name;
    document.getElementById('currentQtyDisplay').textContent = stock.quantity ?? 0;
    document.getElementById('currentQtyUnit').textContent = ' ' + (stock.unit || 'ชิ้น');
    document.getElementById('reorderPoint').value = stock.reorder_point ?? 2;
    document.getElementById('unitInput').value = stock.unit || 'ชิ้น';
    document.getElementById('deltaQty').value = '';
    document.getElementById('operatorName').value = '';
    document.getElementById('reason').value = '';
    document.getElementById('chkDeductBom').checked = false;

    setAdjustMode('receive');

    // Check if BOM exists for this product code
    const { data: bom } = await db
        .from('stock_bom')
        .select('id')
        .eq('product_code', productCode)
        .limit(1);

    const bomSection = document.getElementById('bomSection');
    if (bomSection) {
        bomSection.style.display = (bom && bom.length > 0) ? '' : 'none';
    }

    const modal = document.getElementById('adjustModal');
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('active'), 10);
    document.getElementById('deltaQty').focus();
}

function closeModal() {
    const modal = document.getElementById('adjustModal');
    modal.classList.remove('active');
    setTimeout(() => { modal.style.display = 'none'; }, 250);
    currentEditProduct = null;
}

function setAdjustMode(mode) {
    adjustMode = mode;
    const btnReceive = document.getElementById('btnReceive');
    const btnIssue = document.getElementById('btnIssue');
    const deltaLabel = document.getElementById('deltaLabel');
    const bomSection = document.getElementById('bomSection');

    btnReceive?.classList.toggle('selected', mode === 'receive');
    btnIssue?.classList.toggle('selected', mode === 'issue');

    if (deltaLabel) {
        deltaLabel.textContent = mode === 'receive' ? 'จำนวนรับเข้าคลัง *' : 'จำนวนจ่ายออกจากคลัง *';
    }

    // BOM section only relevant when receiving
    if (bomSection) {
        // Only show if it was already discovered to have BOM (display !== 'none' from the BOM check)
        if (mode === 'issue') {
            bomSection.setAttribute('data-hidden-by-mode', 'true');
            bomSection.style.display = 'none';
        } else {
            if (bomSection.getAttribute('data-hidden-by-mode') === 'true') {
                bomSection.removeAttribute('data-hidden-by-mode');
                // Re-check if bom was available; if bomSection had display=none before this mode change, keep it hidden
            }
        }
    }
}

// ─── FORM SUBMIT ─────────────────────────────────────────────────
async function handleAdjustSubmit(e) {
    e.preventDefault();

    if (!currentEditProduct) return;

    const delta = parseInt(document.getElementById('deltaQty').value) || 0;
    const operatorName = document.getElementById('operatorName').value.trim();
    const reasonText = document.getElementById('reason').value.trim();
    const reorderPoint = parseInt(document.getElementById('reorderPoint').value) || 2;
    const unit = document.getElementById('unitInput').value.trim() || 'ชิ้น';
    const deductBom = document.getElementById('chkDeductBom')?.checked && adjustMode === 'receive';

    if (!delta || delta <= 0) {
        showToast('กรุณาระบุจำนวนที่ถูกต้อง', 'error');
        return;
    }

    if (!operatorName) {
        showToast('กรุณาระบุชื่อผู้ปฏิบัติการ', 'error');
        return;
    }

    const submitBtn = document.getElementById('submitBtn');
    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ กำลังบันทึก...';

    try {
        const { product_code, quantity: currentQty } = currentEditProduct;

        if (deductBom && adjustMode === 'receive') {
            // Use RPC to deduct raw material via BOM and add to backup
            const { data, error } = await db.rpc('rpc_deduct_components_for_backup_production', {
                p_product_code: product_code,
                p_qty: delta,
                p_operator: operatorName,
                p_reason: reasonText || null
            });

            if (error) throw error;
            if (data?.status === 'error') throw new Error(data.message || 'RPC ล้มเหลว');

            showToast(`✅ รับเข้า ${delta} ${unit} และตัดวัสดุ BOM สำเร็จ`, 'success');

        } else {
            // Direct adjust without BOM deduction
            const newQty = adjustMode === 'receive'
                ? currentQty + delta
                : currentQty - delta;

            if (newQty < 0) {
                showToast(`❌ สต็อกสำรองไม่เพียงพอ (มี ${currentQty}, ต้องการ ${delta})`, 'error');
                submitBtn.disabled = false;
                submitBtn.textContent = '💾 บันทึกการปรับปรุง';
                return;
            }

            const signedDelta = adjustMode === 'receive' ? delta : -delta;

            // Upsert backup stock quantity
            const { error: upsertErr } = await db
                .from('production_backup_stock')
                .upsert({ product_code, quantity: newQty, reorder_point: reorderPoint, unit, updated_at: new Date().toISOString() }, { onConflict: 'product_code' });

            if (upsertErr) throw upsertErr;

            // Write log
            const reasonFull = reasonText || (adjustMode === 'receive' ? 'รับสินค้าสำเร็จรูปเข้าคลัง' : 'จ่ายออก / ใช้สินค้าสำรอง');
            const { error: logErr } = await db
                .from('production_backup_stock_log')
                .insert({
                    product_code,
                    old_qty: currentQty,
                    new_qty: newQty,
                    delta: signedDelta,
                    operator: operatorName,
                    reason: reasonFull
                });

            if (logErr) console.error('Log error:', logErr);

            showToast(`✅ ${adjustMode === 'receive' ? 'รับเข้า' : 'จ่ายออก'} ${delta} ${unit} สำเร็จ`, 'success');
        }

        // Also save reorder_point & unit regardless of mode
        await db
            .from('production_backup_stock')
            .upsert({ product_code, reorder_point: reorderPoint, unit }, { onConflict: 'product_code' });

        closeModal();
        await refreshBackupStockList();
        await loadMovementLogs();

    } catch (err) {
        showToast('❌ บันทึกล้มเหลว: ' + err.message, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '💾 บันทึกการปรับปรุง';
    }
}

// ─── Close modal on backdrop click ─────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('adjustModal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }
});
