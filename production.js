// production.js

// ─── CONFIG ───────────────────────────────
// ใช้ค่าจาก config.js (ถูก gitignore ไม่ให้ขึ้น GitHub)
const TABLE = 'stock_orders';
const db = window.auth?.supabase
    || (window.supabase && window.SUPABASE_CONFIG
        ? window.supabase.createClient(window.SUPABASE_CONFIG.URL, window.SUPABASE_CONFIG.KEY)
        : null);
if (!db) {
    console.error('Supabase client ไม่ถูกสร้าง. ตรวจสอบว่า auth.js และ config.js โหลดแล้วหรือไม่');
}

// ─── STATE ────────────────────────────────
let allOrders = [];
let activeTab = 'pending'; // 'pending' | 'producing' | 'done'
const pendingStatusUpdates = new Set();
const ordersWithUndispatchedMaterials = new Set(); // order IDs ที่ยังไม่จ่ายวัสดุ
const ordersWithPendingDamaged = new Set(); // order IDs ที่มีวัสดุชำรุดยังไม่ถูกยืนยันจ่าย
let dispatchPollInterval = null; // polling interval สำหรับ file:// protocol

// ─── PRODUCTION STATUSES ──────────────────
const STATUS_PENDING = 'รอดำเนินการ';
const STATUS_PRODUCING = 'กำลังผลิต';
const STATUS_DONE = 'ผลิตสำเร็จแล้ว';
const PROD_STATUSES = [STATUS_PENDING, STATUS_PRODUCING, STATUS_DONE];

function log(msg, type = 'info') {
    const el = document.getElementById('logBar');
    const colorMap = { info: '#94a3b8', success: '#34d399', error: '#f87171', warn: '#fbbf24' };
    if (el) {
        el.innerHTML = `<span style="color:${colorMap[type] || colorMap.info}">[${new Date().toLocaleTimeString()}] ${msg}</span>`;
    }
    console.log(`[${type}] ${msg}`);
    // บังคับแสดง Toast สำหรับเหตุการณ์สำคัญ
    if (['success', 'error', 'warn'].includes(type) || msg.includes('สำเร็จ') || msg.includes('ล้มเหลว')) {
        showToast(msg, type);
    }
}

function showToast(msg, type = 'info') {
    const container = document.getElementById('toastContainer') || createToastContainer();
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = { success: '✅', error: '❌', info: 'ℹ️', warn: '⚠️' }[type] || 'ℹ️';
    toast.innerHTML = `<span>${icon}</span><span style="font-size:0.88rem;">${msg}</span>`;
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

function createToastContainer() {
    const div = document.createElement('div');
    div.id = 'toastContainer';
    div.className = 'toast-container';
    document.body.appendChild(div);
    return div;
}

// ─── LOAD DATA ────────────────────────────
async function loadData() {
    log('กำลังโหลดข้อมูลจาก Supabase...');
    const selectColumns = 'id,order_date,platform,order_number,tracking_number,product_code,product_name,product_size,slots,quantity,buyer_name,tracking_status,note,pattern,production_started_at,production_completed_at,aluminum_color,glass_color,screen_type,stock_deducted';
    const fallbackColumns = 'id,order_date,platform,order_number,tracking_number,product_code,product_name,product_size,slots,quantity,buyer_name,tracking_status,note,pattern,production_started_at,production_completed_at,aluminum_color,glass_color,screen_type';
    try {
        let response = await db
            .from(TABLE)
            .select(selectColumns)
            .in('tracking_status', PROD_STATUSES)
            .is('tracking_number', null)
            .order('order_date', { ascending: true });

        if (response.error) {
            const message = String(response.error.message || '');
            if (/stock_deducted/i.test(message)) {
                log('stock_deducted ยังไม่มีใน schema, โหลดข้อมูลโดยไม่ใส่คอลัมน์นี้', 'warn');
                response = await db
                    .from(TABLE)
                    .select(fallbackColumns)
                    .in('tracking_status', PROD_STATUSES)
                    .is('tracking_number', null)
                    .order('order_date', { ascending: true });
            }
        }

        if (response.error) throw response.error;
        allOrders = response.data || [];
        log(`โหลดสำเร็จ ${allOrders.length} รายการ`, 'success');
        document.getElementById('lastUpdated').textContent =
            `อัพเดต: ${new Date().toLocaleString('th-TH')} | ${allOrders.length} รายการ`;
        // ดึงข้อมูล dispatch status แบบ batch เพื่อแสดง indicator บน card
        await enrichOrdersWithDispatchStatus();
        await enrichOrdersWithDamageStatus();
        applyFilters();
    } catch (err) {
        log(`โหลดล้มเหลว: ${err.message}`, 'error');
        document.getElementById('ordersContainer').innerHTML = `
            <div class="empty-state" style="padding:1.5rem;">
                <p style="color:#f87171;">❌ โหลดรายการล้มเหลว: ${esc(err.message)}</p>
            </div>`;
        document.getElementById('summaryTableBody').innerHTML = `
            <tr><td colspan="10" style="text-align:center;padding:2rem;color:var(--muted);">
                ❌ โหลดสรุปล้มเหลว
            </td></tr>`;
        document.getElementById('kpiPending').textContent = '-';
        document.getElementById('kpiProducing').textContent = '-';
        document.getElementById('kpiDone').textContent = '-';
        document.getElementById('kpiQty').textContent = '-';
    }
}

// ─── DISPATCH STATUS ENRICHMENT ──────────
async function enrichOrdersWithDispatchStatus() {
    ordersWithUndispatchedMaterials.clear();
    // เฉพาะออเดอร์ที่กำลังผลิต และตัดสต็อกไปแล้ว
    const producingOrders = allOrders.filter(o =>
        o.tracking_status === STATUS_PRODUCING && o.stock_deducted === true
    );
    if (!producingOrders.length) return;

    try {
        const { data: logs, error } = await db
            .from('stock_movement_log')
            .select('reason')
            .eq('dispatched', false)
            .like('reason', 'ตัดสต็อกอัตโนมัติ (เริ่มผลิต%');

        if (error) { console.error('enrichDispatch error:', error); return; }
        if (!logs || !logs.length) return;

        producingOrders.forEach(o => {
            const found = logs.some(log =>
                log.reason && log.reason.includes(`ID ออเดอร์: ${o.id}`)
            );
            if (found) ordersWithUndispatchedMaterials.add(o.id);
        });
    } catch (err) {
        console.error('enrichDispatch exception:', err);
    }
}

// ตรวจสอบว่ามีรายการวัสดุชำรุดที่ยังไม่ถูกยืนยันจ่าย (status != 'delivered')
async function enrichOrdersWithDamageStatus() {
    ordersWithPendingDamaged.clear();
    try {
        const { data, error } = await db
            .from('damaged_materials')
            .select('order_id')
            .neq('status', 'delivered');
        if (error) { console.error('enrichDamage error:', error); return; }
        if (!data || !data.length) return;
        data.forEach(r => {
            if (r && r.order_id) ordersWithPendingDamaged.add(r.order_id);
        });
    } catch (err) {
        console.error('enrichDamage exception:', err);
    }
}

// ─── FILTERS ──────────────────────────────
function getFiltered(statusList) {
    const platform = document.getElementById('filterPlatform').value;
    const dateFrom = document.getElementById('filterDateFrom').value;
    const dateTo = document.getElementById('filterDateTo').value;
    const completedDate = document.getElementById('filterCompletedDate').value;
    return allOrders.filter(o => {
        if (!statusList.includes(o.tracking_status)) return false;
        if (platform && o.platform !== platform) return false;
        if (dateFrom && o.order_date < dateFrom) return false;
        if (dateTo && o.order_date > dateTo) return false;

        if (completedDate) {
            if (!o.production_completed_at) return false;
            const d = new Date(o.production_completed_at);
            const offset = d.getTimezoneOffset() * 60000;
            const localDateStr = (new Date(d - offset)).toISOString().split('T')[0];
            if (localDateStr !== completedDate) return false;
        }

        return true;
    });
}

function applyFilters() {
    const pending = getFiltered([STATUS_PENDING]);
    const producing = getFiltered([STATUS_PRODUCING]);
    const done = getFiltered([STATUS_DONE]);

    // KPIs
    document.getElementById('kpiPending').textContent = pending.length;
    document.getElementById('kpiProducing').textContent = producing.length;
    document.getElementById('kpiDone').textContent = done.length;
    const totalQty = [...pending, ...producing].reduce((s, o) => s + (parseInt(o.quantity) || 1), 0);
    document.getElementById('kpiQty').textContent = totalQty.toLocaleString('th-TH');

    // Tab counts
    document.getElementById('tc-pending').textContent = pending.length;
    document.getElementById('tc-producing').textContent = producing.length;
    document.getElementById('tc-done').textContent = done.length;

    // Summary table (pending + producing)
    renderSummaryTable([...pending, ...producing]);

    renderCards();
}

function clearFilters() {
    ['filterPlatform', 'filterDateFrom', 'filterDateTo', 'filterCompletedDate'].forEach(id => {
        document.getElementById(id).value = '';
    });
    applyFilters();
}

// ─── TABS ─────────────────────────────────
const TAB_CFG = {
    pending: { label: '📦 รายการออเดอร์รอผลิต', cls: 'active-pending' },
    producing: { label: '🔨 รายการกำลังผลิต', cls: 'active-producing' },
    done: { label: '✅ รายการผลิตสำเร็จแล้ว', cls: 'active-done' }
};

function switchTab(tab) {
    activeTab = tab;
    ['pending', 'producing', 'done'].forEach(t => {
        const btn = document.getElementById('tab-' + t);
        btn.className = 'tab-btn' + (t === tab ? ' ' + TAB_CFG[t].cls : '');
    });
    document.getElementById('panelTitle').textContent = TAB_CFG[tab].label;
    renderCards();
}

// ─── SUMMARY TABLE ────────────────────────
function buildGroups(orders) {
    const groups = {};
    orders.forEach(o => {
        const key = [
            (o.product_code || '').toLowerCase(), 
            (o.product_name || '').toLowerCase(), 
            (o.product_size || ''), 
            (o.slots ?? ''), 
            (o.pattern || ''),
            (o.aluminum_color || ''),
            (o.glass_color || ''),
            (o.screen_type || '')
        ].join('|');
        if (!groups[key]) groups[key] = { 
            product_code: o.product_code || '', 
            product_name: o.product_name || '', 
            product_size: o.product_size || '', 
            slots: o.slots, 
            pattern: o.pattern || '',
            aluminum_color: o.aluminum_color || '',
            glass_color: o.glass_color || '',
            screen_type: o.screen_type || '',
            totalQty: 0, 
            orderCount: 0 
        };
        groups[key].totalQty += parseInt(o.quantity) || 1;
        groups[key].orderCount += 1;
    });
    return Object.values(groups).sort((a, b) => b.totalQty - a.totalQty);
}

function renderSummaryTable(orders) {
    const groups = buildGroups(orders);
    document.getElementById('summaryCount').textContent = `(${groups.length} รายการสินค้า)`;
    const tbody = document.getElementById('summaryTableBody');
    if (!groups.length) {
        tbody.innerHTML = `<tr><td colspan="10"><div class="empty-state"><div class="emoji">✅</div><p>ไม่มีรายการ</p></div></td></tr>`;
        return;
    }
    tbody.innerHTML = groups.map((g, i) => `
        <tr>
            <td style="color:var(--muted);width:36px;">${i + 1}</td>
            <td>
                ${g.product_code ? `<div class="sku-text">${esc(g.product_code)}</div>` : ''}
                <div style="font-weight:500;margin-top:2px;">${esc(g.product_name)}</div>
            </td>
            <td>${g.product_size ? `<span style="background:rgba(168,85,247,0.15);color:#c084fc;padding:2px 8px;border-radius:20px;font-size:0.8rem;">${esc(g.product_size)}</span>` : '-'}</td>
            <td>${g.pattern ? `<span style="background:rgba(16,185,129,0.12);color:#34d399;padding:2px 8px;border-radius:20px;font-size:0.8rem;">${esc(g.pattern)}</span>` : '-'}</td>
            <td>${g.slots != null ? `<span style="color:#60a5fa;font-weight:600;">${g.slots} ช่อง</span>` : '-'}</td>
            <td><span style="color:#cbd5e1;">${esc(g.aluminum_color || '-')}</span></td>
            <td><span style="color:#cbd5e1;">${esc(g.glass_color || '-')}</span></td>
            <td><span style="color:#cbd5e1; font-size:0.85rem;">${esc(g.screen_type || '-')}</span></td>
            <td><span class="qty-badge">${g.totalQty}</span></td>
            <td><span style="background:rgba(59,130,246,0.15);color:#60a5fa;border:1px solid rgba(59,130,246,0.25);padding:3px 10px;border-radius:20px;font-size:0.8rem;">${g.orderCount} ออเดอร์</span></td>
        </tr>`).join('');
}

async function logStockMovement(itemId, itemName, oldQty, newQty, userName, reason) {
    try {
        const { error } = await db
            .from('stock_movement_log')
            .insert([{
                item_id:   itemId,
                item_name: itemName,
                old_qty:   oldQty,
                new_qty:   newQty,
                operator:  userName.trim(),
                reason:    reason ? reason.trim() : null
            }]);
        if (error) {
            console.error('Error logging movement:', error);
        }
    } catch (err) {
        console.error('Catch error logging movement:', err);
    }
}

async function addBackupStockForCompletedOrder(order) {
    const qty = parseInt(order?.quantity) || 1;
    const productCode = (order?.product_code || '').trim();
    const trackingNumber = (order?.tracking_number || '').trim();
    const hasTracking = trackingNumber !== '' && trackingNumber !== '-' && trackingNumber !== 'null';

    if (!productCode) {
        log(`⚠️ ไม่สามารถเพิ่มสต็อกสำรองสำหรับออเดอร์ ${order?.order_number || order?.id} เพราะไม่มี SKU`, 'warn');
        return false;
    }

    if (hasTracking) {
        log(`⏭️ ข้ามการเพิ่มสต็อก - เนื่องจากมีเลขพัสดุแล้ว: ${trackingNumber}`, 'info');
        return true;
    }

    try {
        console.log(`[DEBUG] addBackupStock: productCode=${productCode}, qty=${qty}`);
                
        const { data: existing, error: selectError } = await db
            .from('production_backup_stock')
            .select('id, quantity')
            .eq('product_code', productCode)
            .maybeSingle();

        if (selectError) throw selectError;
        console.log(`[DEBUG] Query result: existing=`, existing);

        const oldQty = parseInt(existing?.quantity) || 0;
        const newQty = oldQty + qty;
        const reasonText = `ผลิตสำเร็จแล้ว แต่ยังไม่มีเลขพัสดุ | source: backup-stock-add | order_id: ${order?.id} | order_number: ${order?.order_number || '-'} | sku: ${productCode} | qty: ${qty}`;

        if (existing?.id) {
            console.log(`[DEBUG] UPDATE path: id=${existing.id}, oldQty=${oldQty}, newQty=${newQty}`);
            const updateResult = await db
                .from('production_backup_stock')
                .update({ quantity: newQty, updated_at: new Date().toISOString() })
                .eq('id', existing.id);
            console.log(`[DEBUG] UPDATE result:`, updateResult);
            if (updateResult.error) {
                throw new Error(`UPDATE failed: ${updateResult.error.message}`);
            }
            console.log(`[DEBUG] UPDATE success`);
        } else {
            console.log(`[DEBUG] INSERT path: productCode=${productCode}, qty=${newQty}`);
            const insertResult = await db
                .from('production_backup_stock')
                .insert([{ product_code: productCode, quantity: newQty, reorder_point: 2, unit: 'ชิ้น' }]);
            console.log(`[DEBUG] INSERT result:`, insertResult);
            if (insertResult.error) {
                throw new Error(`INSERT failed: ${insertResult.error.message}`);
            }
            console.log(`[DEBUG] INSERT success`);
        }

        const { error: logError } = await db
            .from('production_backup_stock_log')
            .insert([{ product_code: productCode, old_qty: oldQty, new_qty: newQty, delta: qty, operator: 'ระบบ', reason: reasonText }]);
        if (logError) throw new Error(`LOG INSERT failed: ${logError.message}`);
        console.log(`[DEBUG] LOG INSERT success`);

        log(`📦 เพิ่มสต็อกสำรอง ${productCode} +${qty} ชิ้น (คงเหลือ ${newQty})`, 'success');
        return true;
    } catch (err) {
        console.error(`[ERROR] addBackupStock:`, err);
        log(`❌ เพิ่มสต็อกสำรองล้มเหลว: ${err.message}`, 'error');
        return false;
    }
}

async function removeBackupStockForRevertedOrder(order) {
    const qty = parseInt(order?.quantity) || 1;
    const productCode = (order?.product_code || '').trim();
    const trackingNumber = (order?.tracking_number || '').trim();

    if (!productCode) {
        log(`⚠️ ไม่สามารถลดสต็อกสำรองได้ เนื่องจากออเดอร์ไม่มี SKU`, 'warn');
        return true;
    }

    if (trackingNumber !== '' && trackingNumber !== '-' && trackingNumber.toLowerCase() !== 'null') {
        log(`⏭️ ไม่ลดสต็อกสำรองสำหรับออเดอร์ที่มีเลขพัสดุแล้ว: ${trackingNumber}`, 'info');
        return true;
    }

    try {
        const { data: existing, error: selectError } = await db
            .from('production_backup_stock')
            .select('id, quantity')
            .eq('product_code', productCode)
            .maybeSingle();

        if (selectError) throw selectError;

        if (!existing) {
            log(`⚠️ ไม่พบสต็อกสำรองสำหรับ SKU ${productCode} เพื่อคืนสถานะ`, 'warn');
            return true;
        }

        const oldQty = parseInt(existing.quantity) || 0;
        const newQty = Math.max(oldQty - qty, 0);

        const { error: updateError } = await db
            .from('production_backup_stock')
            .update({ quantity: newQty, updated_at: new Date().toISOString() })
            .eq('id', existing.id);
        if (updateError) throw updateError;

        const reasonText = `ลดสต็อกสำรอง เนื่องจากย้อนกลับสถานะจากผลิตสำเร็จแล้ว | source: backup-stock-revert | order_id: ${order?.id} | order_number: ${order?.order_number || '-'} | sku: ${productCode} | qty: ${qty}`;
        const { error: logError } = await db
            .from('production_backup_stock_log')
            .insert([{ product_code: productCode, old_qty: oldQty, new_qty: newQty, delta: -qty, operator: 'ระบบ', reason: reasonText }]);
        if (logError) throw logError;

        log(`📉 ลดสต็อกสำรอง ${productCode} -${qty} ชิ้น (คงเหลือ ${newQty})`, 'success');
        return true;
    } catch (err) {
        console.error(`[ERROR] removeBackupStock:`, err);
        log(`❌ ลดสต็อกสำรองล้มเหลว: ${err.message}`, 'error');
        return false;
    }
}

async function deductSingleStockForOrder(order) {
    const normalizedProductCode = String(order.product_code || '').trim();
    const normalizedProductName = String(order.product_name || '').trim();
    const normalizedCodeKey = normalizedProductCode.replace(/\s+/g, '').toUpperCase();
    const normalizedNameKey = normalizedProductName.replace(/\s+/g, '').toUpperCase();

    if (!normalizedProductCode && !normalizedProductName) {
        log(`ออเดอร์ ${order?.order_number || order?.id} ไม่มี product_code หรือ product_name`, 'warn');
        return false;
    }

    try {
        let stockItem = null;
        let result;

        // 1) Match by product_code (direct then partial)
        if (normalizedProductCode) {
            result = await db.from('stock_items').select('*').eq('product_code', normalizedProductCode).maybeSingle();
            if (!result.error && result.data) stockItem = result.data;
            
            if (!stockItem) {
                result = await db.from('stock_items').select('*').ilike('product_code', `%${normalizedProductCode}%`).limit(1);
                if (!result.error && result.data?.length > 0) stockItem = result.data[0];
            }
        }

        // 2) Match by product_name (direct then partial)
        if (!stockItem && normalizedProductName) {
            result = await db.from('stock_items').select('*').eq('product_name', normalizedProductName).maybeSingle();
            if (!result.error && result.data) stockItem = result.data;

            if (!stockItem) {
                result = await db.from('stock_items').select('*').ilike('product_name', `%${normalizedProductName}%`).limit(1);
                if (!result.error && result.data?.length > 0) stockItem = result.data[0];
            }
        }

        // 3) Whitespace-agnostic fallback
        if (!stockItem) {
            result = await db.from('stock_items').select('*');
            if (!result.error && result.data) {
                stockItem = result.data.find(item => {
                    const code = String(item.product_code || '').replace(/\s+/g, '').toUpperCase();
                    const name = String(item.product_name || '').replace(/\s+/g, '').toUpperCase();
                    return (normalizedCodeKey && (code === normalizedCodeKey || code.includes(normalizedCodeKey) || normalizedCodeKey.includes(code)))
                        || (normalizedNameKey && (name === normalizedNameKey || name.includes(normalizedNameKey) || normalizedNameKey.includes(name)));
                });
            }
        }

        if (!stockItem) {
            throw new Error(`วัสดุในการผลิตไม่เพียงพอ ${normalizedProductCode || normalizedProductName}`);
        }

        const currentQty = parseInt(stockItem.quantity) || 0;
        const orderQty = parseInt(order.quantity) || 1;
        const updatedQty = currentQty - orderQty;

        if (updatedQty < 0) throw new Error(`สินค้า '${stockItem.product_name}' สต็อกไม่พอ (มี ${currentQty}, ใช้ ${orderQty})`);

        const { error: updateError } = await db.from('stock_items').update({ quantity: updatedQty }).eq('id', stockItem.id);
        if (updateError) throw updateError;

        // Log movement as System
        const reasonStr = `ตัดสต็อกอัตโนมัติ (เริ่มผลิต, ไม่มี BOM) | source: production-start-1to1 | order_id: ${order.id} | order_number: ${order.order_number || '-'} | sku: ${order.product_code || '-'} | item: ${stockItem.product_name || stockItem.product_code}`;
        await logStockMovement(stockItem.id, stockItem.product_name, currentQty, updatedQty, 'ระบบ', reasonStr);

        log(`ตัดสต็อก ${stockItem.product_name || stockItem.product_code} ${orderQty} ชิ้น (คงเหลือ ${updatedQty})`, 'success');
        return true;
    } catch (err) {
        log(`ตัดสต็อกล้มเหลว: ${err.message}`, 'error');
        throw err;
    }
}

async function returnSingleStockForOrder(order) {
    const normalizedProductCode = String(order.product_code || '').trim();
    const normalizedProductName = String(order.product_name || '').trim();
    const normalizedCodeKey = normalizedProductCode.replace(/\s+/g, '').toUpperCase();
    const normalizedNameKey = normalizedProductName.replace(/\s+/g, '').toUpperCase();

    try {
        let stockItem = null;
        let result;

        // 1) Match by product_code
        if (normalizedProductCode) {
            result = await db.from('stock_items').select('*').eq('product_code', normalizedProductCode).maybeSingle();
            if (!result.error && result.data) stockItem = result.data;
        }
        // 2) Match by product_name
        if (!stockItem && normalizedProductName) {
            result = await db.from('stock_items').select('*').eq('product_name', normalizedProductName).maybeSingle();
            if (!result.error && result.data) stockItem = result.data;
        }
        // 3) Fallback to search
        if (!stockItem) {
            result = await db.from('stock_items').select('*');
            if (!result.error && result.data) {
                stockItem = result.data.find(item => {
                    const code = String(item.product_code || '').replace(/\s+/g, '').toUpperCase();
                    const name = String(item.product_name || '').replace(/\s+/g, '').toUpperCase();
                    return (normalizedCodeKey && code === normalizedCodeKey) || (normalizedNameKey && name === normalizedNameKey);
                });
            }
        }

        if (!stockItem) {
            log(`คืนสต็อกล้มเหลว: ไม่พบสินค้า ${normalizedProductCode || normalizedProductName}`, 'warn');
            return false;
        }

        const currentQty = parseInt(stockItem.quantity) || 0;
        const orderQty = parseInt(order.quantity) || 1;
        const updatedQty = currentQty + orderQty;

        const { error: updateError } = await db.from('stock_items').update({ quantity: updatedQty }).eq('id', stockItem.id);
        if (updateError) throw updateError;

        // Log movement as System
        const reasonStr = `คืนสต็อกอัตโนมัติ (ย้อนกลับ, ไม่มี BOM) | source: production-return-1to1 | order_id: ${order.id} | order_number: ${order.order_number || '-'} | sku: ${order.product_code || '-'} | item: ${stockItem.product_name || stockItem.product_code}`;
        await logStockMovement(stockItem.id, stockItem.product_name, currentQty, updatedQty, 'ระบบ', reasonStr);

        log(`คืนสต็อก ${stockItem.product_name || stockItem.product_code} ${orderQty} ชิ้น (คงเหลือ ${updatedQty})`, 'success');
        return true;
    } catch (err) {
        log(`คืนสต็อกล้มเหลว: ${err.message}`, 'error');
        throw err;
    }
}

// ─── BOM / RPC Helpers ─────────────────────
async function fetchComponentsForOrder(order) {
    try {
        // First check per-order overrides
        const { data: oc, error: ocErr } = await db.from('order_components')
            .select('component_product_code, component_qty')
            .eq('order_id', order.id);
        if (!ocErr && oc && oc.length) return oc.map(r => ({ component_product_code: r.component_product_code, component_qty: parseInt(r.component_qty) || 1 }));

        // Fallback to BOM table
        const { data: bom, error: bomErr } = await db.from('stock_bom')
            .select('component_product_code, component_qty')
            .eq('product_code', order.product_code);
        if (bomErr) throw bomErr;
        return (bom || []).map(r => ({ component_product_code: r.component_product_code, component_qty: parseInt(r.component_qty) || 1 }));
    } catch (err) {
        console.error('fetchComponentsForOrder error', err);
        return [];
    }
}

async function fetchStockLevels(codes) {
    if (!codes || !codes.length) return [];
    try {
        const { data, error } = await db.from('stock_items').select('id, product_code, product_name, quantity').in('product_code', codes);
        if (error) throw error;
        return data || [];
    } catch (err) {
        console.error('fetchStockLevels error', err);
        return [];
    }
}

function openComponentsModal(order, comps) {
    return new Promise((resolve) => {
        const modal = document.getElementById('componentsModal');
        const list = document.getElementById('componentsList');
        const confirmBtn = document.getElementById('componentsConfirmBtn');
        
        // Find buttons
        const cancelBtn = modal.querySelector('.cancel-modal');
        const closeBtn = modal.querySelector('.close-modal');

        list.innerHTML = '';

        const hasInsufficientStock = comps.some(c => (parseInt(c.have) || 0) < (parseInt(c.need) || 0));
        const warningHtml = hasInsufficientStock
            ? `<div style="margin-bottom:12px;padding:12px;border-radius:10px;background:rgba(239,68,68,0.12);color:#b91c1c;border:1px solid rgba(239,68,68,0.2);font-size:0.9rem;">
                    ❌ พบรายการที่มีสต็อกไม่เพียงพอ ระบบไม่อนุญาตให้ยืนยันและตัดสต็อกได้ กรุณาเพิ่มสต็อกก่อน</div>`
            : '';

        // Header with Product Info
        const headerInfo = `<div style="padding:10px; border-radius:8px; background:rgba(255,255,255,0.03); margin-bottom:15px; border:1px solid rgba(255,255,255,0.05);">
                    <div style="font-size:0.75rem; color:var(--muted); margin-bottom:4px;">📦 ออเดอร์ #${esc(order.order_number || order.id)}</div>
                    <div style="font-weight:500; font-size:0.9rem;">${esc(order.product_name)}</div>
                    ${order.product_code ? `<div style="font-size:0.75rem; color:var(--primary); margin-top:2px;">SKU: ${esc(order.product_code)}</div>` : ''}
                </div>`;
        list.innerHTML = headerInfo + warningHtml;

        comps.forEach(c => {
            const nameHtml = c.component_product_name 
                ? `<div style="font-size:0.75rem; color:#94a3b8; font-weight:normal; margin-top:2px;">${esc(c.component_product_name)}</div>`
                : '';
            const isInsufficient = (parseInt(c.have) || 0) < (parseInt(c.need) || 0);
            const short = `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);gap:12px;">
                        <div style="flex:1; min-width:0; text-align:left;">
                            <div style="font-weight:600; font-size:0.88rem; color:#f1f5f9; word-break:break-all;">${esc(c.component_product_code)}</div>
                            ${nameHtml}
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;font-size:0.82rem;white-space:nowrap;">
                            <span style="color:var(--muted);">ต้องการ <strong style="color:#fff;">${c.need}</strong></span>
                            <span style="color:rgba(255,255,255,0.15)">|</span>
                            <span style="background:${isInsufficient ? 'rgba(239,68,68,0.12)' : 'rgba(16,185,129,0.12)'}; 
                                         color:${isInsufficient ? '#f87171' : '#34d399'}; 
                                         border:1px solid ${isInsufficient ? 'rgba(239,68,68,0.22)' : 'rgba(16,185,129,0.22)'}; 
                                         padding:2px 8px; border-radius:6px; font-weight:500; font-size:0.78rem;">
                                มี ${c.have}
                            </span>
                        </div>
                    </div>`;
            list.innerHTML += short;
        });

        modal.style.display = 'flex';
        confirmBtn.disabled = hasInsufficientStock;
        confirmBtn.style.cursor = hasInsufficientStock ? 'not-allowed' : '';
        confirmBtn.title = hasInsufficientStock ? 'ไม่สามารถยืนยันได้เมื่อจำนวนสต็อกไม่เพียงพอ' : '';

        const onDone = (result) => {
            modal.style.display = 'none';
            confirmBtn.onclick = null;
            if (cancelBtn) cancelBtn.onclick = null;
            if (closeBtn) closeBtn.onclick = null;
            modal.onclick = null;
            resolve(result);
        };

        confirmBtn.onclick = () => onDone(true);
        if (cancelBtn) cancelBtn.onclick = () => onDone(false);
        if (closeBtn) closeBtn.onclick = () => onDone(false);
        modal.onclick = (e) => { if (e.target === modal) onDone(false); };
    });
}

// Clean up redundant function
function closeComponentsModal() {
    const modal = document.getElementById('componentsModal');
    if (modal) modal.style.display = 'none';
}

async function rpcDeductComponentsForOrder(order) {
    try {
        const { data, error } = await db.rpc('rpc_deduct_components_for_order', { p_order_id: order.id });
        if (error) throw error;
        if (data && data.status === 'ok') return true;
        if (data && data.status === 'error') throw new Error(data.message || 'RPC reported error');
        return true;
    } catch (err) {
        throw err;
    }
}

async function rpcReturnComponentsForOrder(order) {
    try {
        const { data, error } = await db.rpc('rpc_return_components_for_order', { p_order_id: order.id });
        if (error) throw error;
        if (data && data.status === 'ok') return true;
        if (data && data.status === 'error') throw new Error(data.message || 'RPC reported error');
        return true;
    } catch (err) {
        throw err;
    }
}

async function performDeduction(order) {
    try {
        let comps = await fetchComponentsForOrder(order);
        const orderQty = parseInt(order.quantity) || 1;
        let isBOM = true;

        if (!comps || comps.length === 0) {
            // No BOM found — trigger confirmation modal for the main item itself
            isBOM = false;
            comps = [{
                component_product_code: order.product_code || order.product_name || 'ไมนิมระบุ',
                component_qty: 1
            }];
            log(`ไม่มี BOM สำหรับ ${order.product_name} — จะตัดสต็อกแบบ 1:1`, 'info');
        }

        const codes = comps.map(c => c.component_product_code);
        const stockItems = await fetchStockLevels(codes);
        const stockMap = {};
        stockItems.forEach(item => {
            stockMap[item.product_code] = item.quantity;
        });
                
        const compsWithNeed = comps.map(c => {
            const need = (parseInt(c.component_qty) || 1) * orderQty;
            const have = stockMap[c.component_product_code] ?? 0;
            const stockItem = stockItems.find(item => 
                String(item.product_code).trim() === String(c.component_product_code).trim() ||
                String(item.product_name).trim() === String(c.component_product_code).trim()
            );
            const component_product_name = stockItem ? stockItem.product_name : '';
            return { component_product_code: c.component_product_code, component_product_name, need, have };
        });

        // Show confirmation modal (Pop-up like Screenshot 2)
        const confirmed = await openComponentsModal(order, compsWithNeed);
        if (!confirmed) return false;

        if (isBOM) {
            await rpcDeductComponentsForOrder(order);
            // RPC now handles stock_movement_log insertion with reason and operator internally
        } else {
            await deductSingleStockForOrder(order);
        }
                
        log(`ตัดสต็อกสำเร็จสำหรับออเดอร์ ${order.order_number || order.id}`, 'success');
        return true;
    } catch (err) {
        log(`การตัดสต็อกล้มเหลว: ${err.message}`, 'error');
        throw err;
    }
}

async function performReturn(order) {
    try {
        log(`กำลังดำเนินการคืนสต็อกสำหรับ [${order.order_number || order.id}]...`);
                
        const comps = await fetchComponentsForOrder(order);
        if (!comps || comps.length === 0) {
            log(`ไม่มี BOM สำหรับ ${order.product_code || order.product_name} — ใช้การคืนสต็อกแบบ 1:1`, 'warn');
            return await returnSingleStockForOrder(order);
        }

        // Fetch component stock levels before returning
        const codes = comps.map(c => c.component_product_code);
        const stockItems = await fetchStockLevels(codes);

        await rpcReturnComponentsForOrder(order);

        log(`คืนสต็อกสำเร็จ (RPC) สำหรับออเดอร์ ${order.order_number || order.id}`, 'success');
        return true;
    } catch (err) {
        log(`Return stock failed: ${err.message}`, 'error');
        throw err;
    }
}

// ─── ORDER CARD RENDER ──────────────────────────
function renderOrderCard(o) {
    const status = o.tracking_status;
    const platCls = { Shopee: 'p-shopee', Lazada: 'p-lazada', TikTok: 'p-tiktok' }[o.platform] || 'p-other';
    const cardCls = status === STATUS_DONE ? 'is-done' : (status === STATUS_PRODUCING ? 'is-producing' : 'is-pending');

    let badgeHtml = '';
    let actionsHtml = '';

    if (status === STATUS_PENDING) {
        badgeHtml = `<span class="badge badge-pending">⏳ รอผลิต</span>`;
        actionsHtml = `
            <button class="btn btn-outline btn-sm" style="color:#f87171;border-color:rgba(239,68,68,0.3);" onclick="updateStatus('${o.id}','ยกเลิก',this)">❌ ยกเลิก</button>
            <button class="btn btn-produce btn-sm" onclick="updateStatus('${o.id}','${STATUS_PRODUCING}',this)">🔨 เริ่มผลิต</button>`;
    } else if (status === STATUS_PRODUCING) {
        badgeHtml = `<span class="badge badge-producing">🔨 กำลังผลิต</span>`;
        const canFinish = ['Ceo', 'pdtPerson'].includes(window.auth.role);
        actionsHtml = `
            <button class="btn btn-outline btn-sm" onclick="updateStatus('${o.id}','${STATUS_PENDING}',this)">↩ ย้อนกลับ</button>
            <button class="btn btn-sm" style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.35);color:#f87171;" onclick="openDamageModal('${o.id}')">⚠️ วัสดุเสีย</button>
            ${canFinish ? (() => {
                const hasUndispatched = ordersWithUndispatchedMaterials.has(o.id) || ordersWithPendingDamaged.has(o.id);
                const btnStyle = hasUndispatched
                    ? `background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.4);color:#fbbf24;`
                    : ``;
                const btnTitle = hasUndispatched ? `title="⚠️ วัสดุยังไม่เรียบร้อย — กรุณาตรวจสอบในหน้ารายงานวัสดุเสียหาย / คลังวัสดุ"` : ``;
                const btnLabel = hasUndispatched ? `⚠️ วัสดุยังไม่เรียบร้อย` : `✅ ผลิตสำเร็จ`;
                return `<button class="btn btn-done btn-sm" style="${btnStyle}" ${btnTitle} onclick="updateStatus('${o.id}','${STATUS_DONE}',this)">${btnLabel}</button>`;
            })() : ''}`;  
    } else {
        badgeHtml = `<span class="badge badge-proddone">✅ ผลิตสำเร็จแล้ว</span>`;
        actionsHtml = `
            <button class="btn btn-outline btn-sm" onclick="updateStatus('${o.id}','${STATUS_PRODUCING}',this)">↩ ย้อนกลับ</button>`;
    }

    actionsHtml += `<button class="btn btn-outline btn-sm" title="ดูประวัติ" onclick="viewHistory('${o.id}')">📜</button>`;

    const timeDetails = [];
    if (o.production_started_at) {
        const d = new Date(o.production_started_at);
        timeDetails.push(`<div style="font-size:0.75rem;color:#fb923c;margin-top:4px;">▶ เริ่ม: ${d.toLocaleDateString('th-TH')} ${d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</div>`);
    }
    if (o.production_completed_at) {
        const d = new Date(o.production_completed_at);
        timeDetails.push(`<div style="font-size:0.75rem;color:#34d399;margin-top:2px;">✅ เสร็จ: ${d.toLocaleDateString('th-TH')} ${d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}</div>`);
    }

    const details = [
        o.product_size ? `<span class="detail-pill size">📐 ${esc(o.product_size)}</span>` : '',
        o.slots != null ? `<span class="detail-pill slots">🔲 ${o.slots} ช่อง</span>` : '',
        o.pattern ? `<span class="detail-pill pattern">🎨 ${esc(o.pattern)}</span>` : '',
        o.aluminum_color ? `<span class="detail-pill" style="background:rgba(255,255,255,0.05); color:#94a3b8; border:1px solid rgba(255,255,255,0.1);">🏗️ ${esc(o.aluminum_color)}</span>` : '',
        o.glass_color ? `<span class="detail-pill" style="background:rgba(59,130,246,0.1); color:#60a5fa; border:1px solid rgba(59,130,246,0.2);">💎 ${esc(o.glass_color)}</span>` : '',
        o.screen_type ? `<span class="detail-pill" style="background:rgba(16,185,129,0.1); color:#34d399; border:1px solid rgba(16,185,129,0.2);">🦟 ${esc(o.screen_type)}</span>` : '',
        `<span class="detail-pill qty">x${parseInt(o.quantity) || 1} ชิ้น</span>`
    ].filter(Boolean).join('');

    return `
    <div class="order-card ${cardCls}" id="card_${o.id}">
        <div class="card-top">
            ${badgeHtml}
            <div style="text-align:right;">
                <span class="plat ${platCls}">${esc(o.platform)}</span>
                <div class="card-date" style="margin-top:4px;">${o.order_date || '-'}</div>
            </div>
        </div>
        <div>
            <div class="card-product-name">${esc(o.product_name || '-')}</div>
            ${o.product_code ? `<div class="card-sku"># ${esc(o.product_code)}</div>` : ''}
        </div>
        <div class="card-details">${details}</div>
        ${timeDetails.join('')}
        ${o.note ? `<div class="card-note">📝 ${esc(o.note)}</div>` : ''}
        <div style="font-size:0.78rem;color:var(--muted);">👤 ${esc(o.buyer_name || '-')} &nbsp;|&nbsp; #${esc(o.order_number || '-')}</div>
        <div class="card-actions">${actionsHtml}</div>
    </div>`;
}

function renderCards() {
    const statusMap = {
        pending: STATUS_PENDING,
        producing: STATUS_PRODUCING,
        done: STATUS_DONE
    };
    const orders = getFiltered([statusMap[activeTab]]);
    const container = document.getElementById('ordersContainer');

    if (!orders.length) {
        container.innerHTML = `<div class="empty-state"><div class="emoji">✅</div><p>ไม่มีรายการ</p></div>`;
        return;
    }

    container.innerHTML = orders.map(renderOrderCard).join('');
}

// ─── UPDATE STATUS ────────────────────────
async function updateStatus(id, newStatus, btnEl) {
    if (pendingStatusUpdates.has(id)) {
        log(`⚠️ คำสั่งอัปเดตสถานะสำหรับออเดอร์ ${id} ถูกดำเนินการอยู่แล้ว`, 'warn');
        if (btnEl) btnEl.disabled = true;
        return;
    }

    pendingStatusUpdates.add(id);
    if (btnEl) {
        btnEl.disabled = true;
        btnEl.dataset.originalText = btnEl.dataset.originalText || btnEl.innerHTML;
        btnEl.innerHTML = '⏳ กำลังอัปเดต...';
    }

    const order = allOrders.find(o => o.id === id);
    log(`กำลังอัปเดต [${order?.order_number || id}] → ${newStatus}...`);
    const card = document.getElementById(`card_${id}`);
    if (card) card.style.opacity = '0.5';

    try {
        // ตรวจสอบว่ามีรายการจัดเตรียมวัสดุที่ถูกจ่ายแล้วหรือไม่ หากกดย้อนกลับไปเป็น 'รอผลิต'
        if (newStatus === STATUS_PENDING) {
            const { data: dispatchedLogs, error: checkError } = await db
                .from('stock_movement_log')
                .select('id')
                .eq('dispatched', true)
                .like('reason', `%ID ออเดอร์: ${id}%`);

            if (checkError) {
                console.error('Check dispatch error:', checkError);
            } else if (dispatchedLogs && dispatchedLogs.length > 0) {
                log(`❌ ไม่สามารถย้อนกลับได้ เนื่องจากวัสดุถูกจ่ายให้ฝ่ายผลิตแล้ว`, 'error');
                alert(`❌ ไม่สามารถย้อนกลับสถานะเป็น "รอผลิต" ได้\nเนื่องจากวัสดุสำหรับออเดอร์นี้ (#${order?.order_number || id}) ได้ถูกจ่ายให้ฝ่ายผลิตแล้ว`);
                if (card) card.style.opacity = '1';
                if (btnEl) btnEl.disabled = false;
                return;
            }
        }

        const updatePayload = { tracking_status: newStatus };
        const now = new Date().toISOString();
        if (newStatus === STATUS_PRODUCING) {
            updatePayload.production_started_at = now;
            updatePayload.production_completed_at = null;
        } else if (newStatus === STATUS_DONE) {
            updatePayload.production_completed_at = now;
        } else if (newStatus === STATUS_PENDING) {
            updatePayload.production_started_at = null;
            updatePayload.production_completed_at = null;
        }

        const isRevertingFromDone = order?.tracking_status === STATUS_DONE && newStatus !== STATUS_DONE;
        if (isRevertingFromDone) {
            await removeBackupStockForRevertedOrder(order);
        }

        // กำหนดตัวแปรสำหรับตรวจสอบว่าต้องตัดสต็อกหรือไม่
        const isMovingToProducing = (newStatus === STATUS_PRODUCING);
        const isAlreadyProducing = (order?.tracking_status === STATUS_PRODUCING);
        const isAlreadyDeducted = (order?.stock_deducted === true);

        // ต้องตัดสต็อกถ้า: กำลังจะไป 'กำลังผลิต' AND (ยังไม่เคยตัดสต็อก)
        // เราไม่เช็ค production_started_at เพื่อความชัวร์ เพราะอาจมีค่าค้างเก่าได้
        const shouldDeduct = isMovingToProducing && !isAlreadyProducing && !isAlreadyDeducted;

        if (shouldDeduct) {
            log(`📦 ระบบกำลังตรวจสอบส่วนประกอบสำหรับ [${order?.order_number || id}]...`);
            const deducted = await performDeduction(order);
            if (!deducted) {
                log(`⚠️ การตัดสต็อกถูกยกเลิก โดยผู้ใช้ [${order?.order_number || id}]`, 'info');
                if (card) card.style.opacity = '1';
                if (btnEl) {
                    btnEl.disabled = false;
                    btnEl.innerHTML = '🔨 เริ่มผลิต';
                }
                return;
            }
            updatePayload.stock_deducted = true;
        }

        // คืนสต็อกถ้ากดย้อนกลับจากสถานะที่เคยตัดสต็อกไปแล้ว
        const shouldReturn = newStatus === STATUS_PENDING && order?.stock_deducted === true;
        if (shouldReturn) {
            const returnedStatus = await performReturn(order);
            if (returnedStatus) {
                updatePayload.stock_deducted = false;

                // ลบ/อัปเดตประวัติการจัดเตรียมที่ยังไม่ได้จ่าย เพื่อไม่ให้โชว์ในหน้าเตรียมวัสดุอีกต่อไป
                await db
                    .from('stock_movement_log')
                    .update({
                        reason: `คืนสต็อกแล้ว | source: production-return-marked | order_id: ${id} | order_number: ${order?.order_number || '-'} | sku: ${order?.product_code || '-'} | old_reason_contains: ID ออเดอร์: ${id}`
                    })
                    .eq('dispatched', false)
                    .like('reason', `%ID ออเดอร์: ${id}%`);
            }
        }

        if (newStatus === STATUS_DONE) {
            // ── ตรวจสอบว่าจ่ายวัสดุแล้วหรือไม่ ──────────────────────────────
            const { data: undispatchedLogs, error: dispatchCheckErr } = await db
                .from('stock_movement_log')
                .select('id')
                .eq('dispatched', false)
                .like('reason', `%ID ออเดอร์: ${id}%`);

            if (dispatchCheckErr) {
                console.error('Dispatch check error:', dispatchCheckErr);
            } else if (undispatchedLogs && undispatchedLogs.length > 0) {
                log(`❌ ไม่สามารถกดผลิตสำเร็จได้ เนื่องจากยังไม่ได้จ่ายวัสดุให้ฝ่ายผลิต`, 'error');
                alert(`❌ ไม่สามารถกดผลิตสำเร็จได้\n\nกรุณาไปที่หน้า "คลังวัสดุ" แล้วกด "จ่ายวัสดุแล้ว" สำหรับออเดอร์นี้ก่อน`);
                if (card) card.style.opacity = '1';
                if (btnEl) {
                    btnEl.disabled = false;
                    if (btnEl.dataset.originalText) btnEl.innerHTML = btnEl.dataset.originalText;
                }
                pendingStatusUpdates.delete(id);
                return;
            }

            // ── ตรวจสอบว่ามีรายการวัสดุที่รายงานว่าเสียหาย (damaged_materials)
            //     หากมี ต้องถูกยืนยันเป็น 'delivered' ในหน้า damage_report.html ก่อน
            try {
                const { data: undeliveredDamages, error: dmgErr } = await db
                    .from('damaged_materials')
                    .select('id,status')
                    .eq('order_id', id)
                    .neq('status', 'delivered')
                    .limit(1);

                if (dmgErr) {
                    console.error('Damage check error:', dmgErr);
                } else if (undeliveredDamages && undeliveredDamages.length > 0) {
                    log(`❌ ไม่สามารถกดผลิตสำเร็จได้ เนื่องจากพบวัสดุชำรุดที่ยังไม่ได้จ่าย`, 'error');
                    alert(`❌ ไม่สามารถกดผลิตสำเร็จได้\n\nพบรายการวัสดุชำรุดที่ยังไม่ได้กด "จ่ายของแล้ว" ในหน้ารายงานวัสดุเสียหาย (Damage Report)\nกรุณาไปที่หน้า "รายงานวัสดุเสียหาย" และกด "จ่ายของแล้ว" สำหรับรายการที่เกี่ยวข้องก่อน`);
                    if (card) card.style.opacity = '1';
                    if (btnEl) {
                        btnEl.disabled = false;
                        if (btnEl.dataset.originalText) btnEl.innerHTML = btnEl.dataset.originalText;
                    }
                    pendingStatusUpdates.delete(id);
                    return;
                }
            } catch (err) {
                console.error('Error checking damaged_materials:', err);
            }

            const backupAdded = await addBackupStockForCompletedOrder(order);
            if (!backupAdded) {
                throw new Error('เพิ่มสต็อกสำรองล้มเหลว');
            }
        }

        const { error } = await db.from(TABLE).update(updatePayload).eq('id', id);
        if (error) throw error;

        // บันทึกลง Log
        try {
            await db.from('production_logs').insert({
                order_id: id,
                order_number: order?.order_number || '-',
                action: `เปลี่ยนสถานะเป็น ${newStatus}`
            });
        } catch (logErr) {
            console.error('Failed to save log', logErr);
        }

        const idx = allOrders.findIndex(o => o.id === id);
        if (idx !== -1) {
            // If new status is NOT a production status, remove from local list
            if (!PROD_STATUSES.includes(newStatus)) {
                allOrders.splice(idx, 1);
            } else {
                allOrders[idx] = { ...allOrders[idx], ...updatePayload };
            }
        }

        log(`✅ อัปเดตสำเร็จ [${order?.order_number}] → ${newStatus}`, 'success');

        if (card) {
            card.style.transition = 'all 0.35s ease';
            card.style.transform = 'scale(0.9)';
            card.style.opacity = '0';
            setTimeout(() => applyFilters(), 360);
        } else {
            applyFilters();
        }
    } catch (err) {
        log(`อัปเดตล้มเหลว: ${err.message}`, 'error');
        if (card) card.style.opacity = '1';
        if (btnEl) {
            btnEl.disabled = false;
            if (btnEl.dataset.originalText) {
                btnEl.innerHTML = btnEl.dataset.originalText;
            }
        }
        alert(`❌ อัปเดตสถานะล้มเหลว: ${err.message}`);
    } finally {
        pendingStatusUpdates.delete(id);
        if (btnEl && btnEl.dataset.originalText) {
            btnEl.innerHTML = btnEl.dataset.originalText;
        }
    }
}

// ─── SUMMARY MODAL ────────────────────────
function openSummaryModal() {
    const pending = getFiltered([STATUS_PENDING]);
    const producing = getFiltered([STATUS_PRODUCING]);
    const groups = buildGroups([...pending, ...producing]);
    const totalQty = groups.reduce((s, g) => s + g.totalQty, 0);
    const now = new Date().toLocaleString('th-TH');

    let text = `🏭 สรุปการผลิต — ${now}\n${'─'.repeat(40)}\n`;
    text += `📦 รอผลิต: ${pending.length} ออเดอร์ | 🔨 กำลังผลิต: ${producing.length} ออเดอร์\n`;
    text += `🔢 รวมทั้งหมด: ${totalQty} ชิ้น\n${'─'.repeat(40)}\n\n`;
    groups.forEach((g, i) => {
        const sku = g.product_code ? ` [${g.product_code}]` : '';
        const size = g.product_size ? ` ไซส์ ${g.product_size}` : '';
        const slots = g.slots != null ? ` ${g.slots}ช่อง` : '';
        const pattern = g.pattern ? ` ลาย${g.pattern}` : '';
        const al = g.aluminum_color ? ` สีอลู:${g.aluminum_color}` : '';
        const gl = g.glass_color ? ` กระจก:${g.glass_color}` : '';
        const screen = g.screen_type ? ` [${g.screen_type}]` : '';
        text += `${i + 1}. ${g.product_name}${sku}${size}${slots}${pattern}${al}${gl}${screen}\n   ➜ ผลิต ${g.totalQty} ชิ้น (${g.orderCount} ออเดอร์)\n\n`;
    });
    text += `${'─'.repeat(40)}\n✅ ระบบบันทึกสต็อก`;

    document.getElementById('summaryText').textContent = text;
    document.getElementById('summaryModal').style.display = 'flex';
}

function closeSummaryModal() { document.getElementById('summaryModal').style.display = 'none'; }

function doCopy() {
    navigator.clipboard.writeText(document.getElementById('summaryText').textContent).then(() => {
        log('📋 คัดลอกสรุปสำเร็จ!', 'success');
        closeSummaryModal();
        alert('📋 คัดลอกแล้ว! นำไปวางใน LINE ได้เลย ✅');
    });
}

// ─── HISTORY MODAL ────────────────────────
function closeHistoryModal() { document.getElementById('historyModal').style.display = 'none'; }
async function viewHistory(id) {
    document.getElementById('historyModal').style.display = 'flex';
    const content = document.getElementById('historyContent');
    content.innerHTML = `<div class="empty-state"><div class="spinner"></div><p>กำลังโหลดประวัติ...</p></div>`;

    try {
        const { data, error } = await db.from('production_logs')
            .select('*')
            .eq('order_id', id)
            .order('created_at', { ascending: false });
        if (error) throw error;

        if (!data || data.length === 0) {
            content.innerHTML = `<div class="empty-state" style="padding:1rem;"><p>ไม่มีประวัติการอัปเดตสถานะของออเดอร์นี้</p></div>`;
            return;
        }

        content.innerHTML = data.map(lg => {
            const d = new Date(lg.created_at);
            return `<div style="padding:0.8rem; border-bottom:1px solid var(--border); display:flex; flex-direction:column; gap:4px; background: rgba(255,255,255,0.02); margin-bottom:4px; border-radius:10px;">
                <div style="font-weight:600; color:var(--primary-bright); font-size: 0.95rem;">${esc(lg.action)}</div>
                <div style="font-size:0.82rem; color:var(--muted);">📅 ${d.toLocaleDateString('th-TH')} 🕒 ${d.toLocaleTimeString('th-TH')}</div>
            </div>`;
        }).join('');
    } catch (err) {
        content.innerHTML = `<div style="color:#f87171; text-align:center; padding:1rem;">❌ โหลดประวัติล้มเหลว: ${err.message}</div>`;
    }
}

// ─── REALTIME ─────────────────────────────
function setupRealtime() {
    const dot = document.getElementById('rtDot');
    const label = document.getElementById('rtLabel');
    db.channel('prod:stock_orders')
        .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, payload => {
            const { eventType, new: nw, old: ol } = payload;
            if (eventType === 'INSERT') {
                if (PROD_STATUSES.includes(nw.tracking_status) && !nw.tracking_number) {
                    allOrders.push(nw);
                    log(`📥 ออเดอร์ใหม่: ${nw.order_number || '?'}`, 'success');
                }
            } else if (eventType === 'UPDATE') {
                const idx = allOrders.findIndex(o => o.id === nw.id);
                // Only show in production if status is relevant AND has NO tracking number
                if (PROD_STATUSES.includes(nw.tracking_status) && !nw.tracking_number) {
                    if (idx !== -1) allOrders[idx] = { ...allOrders[idx], ...nw };
                    else allOrders.push(nw);
                } else {
                    // Remove if status changed OR tracking number was added
                    if (idx !== -1) allOrders.splice(idx, 1);
                }
                log(`🔄 อัปเดต: ${nw.order_number || '?'}`, 'info');
            }
            else if (eventType === 'DELETE') {
                allOrders = allOrders.filter(o => o.id !== ol.id);
            }
            // re-enrich dispatch status then render
            enrichOrdersWithDispatchStatus().then(() => applyFilters());
        })
        .subscribe(status => {
            if (status === 'SUBSCRIBED') {
                dot.classList.remove('off');
                label.textContent = 'Realtime พร้อม';
            } else {
                dot.classList.add('off');
                label.textContent = 'Realtime ขาด';
            }
        });

    // Listen to stock_movement_log changes (เมื่อมีการจ่ายวัสดุจาก material_prep)
    db.channel('prod:dispatch_watch')
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'stock_movement_log' }, () => {
            enrichOrdersWithDispatchStatus().then(() => applyFilters());
        })
        .subscribe();

    // Listen to damaged_materials changes so UI can reflect pending damaged state
    db.channel('prod:damaged_watch')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'damaged_materials' }, () => {
            enrichOrdersWithDamageStatus().then(() => applyFilters());
        })
        .subscribe();

    // ── Polling Fallback ─────────────────────────────────────────────────
    // Realtime WebSocket ใช้งานไม่ได้บน file:// protocol
    // ดึงข้อมูล dispatch status ใหม่ทุก 10 วินาที เพื่อ sync กับ material_prep
    if (dispatchPollInterval) clearInterval(dispatchPollInterval);
    dispatchPollInterval = setInterval(() => {
        enrichOrdersWithDispatchStatus().then(() => applyFilters());
    }, 10000);
}

// ─── UTILS ────────────────────────────────
function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── DAMAGE REPORT ─────────────────────────
let _damageOrderId = null;

async function openDamageModal(orderId) {
    _damageOrderId = orderId;
    const order = allOrders.find(o => o.id === orderId);
    document.getElementById('damageOrderInfo').textContent =
        `📦 ออเดอร์: ${order?.order_number || orderId}  —  ${order?.product_name || ''}`;
    document.getElementById('damageQty').value = 1;
    document.getElementById('damageReason').value = '';
    document.getElementById('damageReporterName').value = '';
    // Reset border colors
    ['damageReason','damageReporterName'].forEach(id => {
        document.getElementById(id).style.borderColor = '';
    });

    const select = document.getElementById('damageItemSelect');
    select.innerHTML = '<option value="">-- กำลังโหลด... --</option>';
    document.getElementById('damageModal').style.display = 'flex';

    try {
        // 1) ดึง BOM ของสินค้านี้
        let bomCodes = [];
        if (order?.product_code) {
            const { data: bomData } = await db.from('stock_bom')
                .select('component_product_code')
                .eq('product_code', order.product_code);
            bomCodes = (bomData || []).map(r => String(r.component_product_code).trim().toUpperCase());
        }

        // 2) ดึง stock_items ทั้งหมด แล้ว filter ฝั่ง client (รองรับ spacing/case ต่าง)
        const { data, error } = await db.from('stock_items')
            .select('id,product_name,product_code,quantity')
            .order('product_name');
        if (error) throw error;

        const allItems = data || [];
        const filtered = bomCodes.length > 0
            ? allItems.filter(item => {
                const nameKey = String(item.product_name || '').trim().toUpperCase();
                const codeKey = String(item.product_code || '').trim().toUpperCase();
                return bomCodes.some(bc => bc === nameKey || nameKey.includes(bc) || bc.includes(nameKey)
                    || (codeKey && (bc === codeKey || codeKey.includes(bc) || bc.includes(codeKey))));
            })
            : allItems; // Fallback: แสดงทั้งหมดถ้าไม่มี BOM

        if (!filtered.length) {
            select.innerHTML = '<option value="">-- ไม่พบชิ้นส่วนของสินค้านี้ --</option>';
        } else {
            select.innerHTML = filtered.map(item =>
                `<option value="${item.id}" data-name="${esc(item.product_name)}" data-qty="${item.quantity}">${esc(item.product_name)} (มี ${item.quantity})</option>`
            ).join('');
        }
    } catch (err) {
        log(`ไม่สามารถโหลดรายการชิ้นส่วน: ${err.message}`, 'error');
        select.innerHTML = '<option value="">-- โหลดล้มเหลว --</option>';
    }
}

function closeDamageModal() {
    document.getElementById('damageModal').style.display = 'none';
    _damageOrderId = null;
}

async function submitDamageReport() {
    const select = document.getElementById('damageItemSelect');
    const itemId = select.value;
    const itemName = select.selectedOptions[0]?.dataset?.name || select.selectedOptions[0]?.text || '';
    const currentQty = parseInt(select.selectedOptions[0]?.dataset?.qty) || 0;
    const damageQty = parseInt(document.getElementById('damageQty').value) || 1;
    const reason = document.getElementById('damageReason').value.trim();
    const reporterName = document.getElementById('damageReporterName').value.trim();

    // ─── Validate all required fields ────────────────────────────
    let hasError = false;
    if (!itemId) {
        log('⚠️ กรุณาเลือกชิ้นส่วนที่เสียหาย', 'warn');
        select.style.borderColor = '#ef4444';
        hasError = true;
    } else {
        select.style.borderColor = '';
    }
    if (!reason) {
        document.getElementById('damageReason').style.borderColor = '#ef4444';
        document.getElementById('damageReason').focus();
        log('⚠️ กรุณาระบุเหตุผล / หมายเหตุ', 'warn');
        hasError = true;
    } else {
        document.getElementById('damageReason').style.borderColor = '';
    }
    if (!reporterName) {
        document.getElementById('damageReporterName').style.borderColor = '#ef4444';
        document.getElementById('damageReporterName').focus();
        log('⚠️ กรุณาระบุชื่อฝ่ายผลิต (ผู้รายงาน)', 'warn');
        hasError = true;
    } else {
        document.getElementById('damageReporterName').style.borderColor = '';
    }
    if (hasError) return;

    if (damageQty <= 0) { log('⚠️ จำนวนต้องมากกว่า 0', 'warn'); return; }
    if (damageQty > currentQty) {
        log(`⚠️ จำนวนที่เสียหาย (${damageQty}) มากกว่าจำนวนในสต็อก (${currentQty})`, 'warn');
        return;
    }

    const newQty = currentQty - damageQty;

    // Disable button while submitting
    const submitBtn = document.querySelector('#damageModal .modal-actions button:last-child');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '⏳ กำลังบันทึก...'; }

    try {
        // 1) Deduct stock
        const { error: deductErr } = await db.from('stock_items')
            .update({ quantity: newQty, updated_at: new Date().toISOString() })
            .eq('id', itemId);
        if (deductErr) throw deductErr;

        // 2) Write to damaged_materials table (with reporter name)
        const order = _damageOrderId ? allOrders.find(o => o.id === _damageOrderId) : null;
        const { data: dmgData, error: logErr } = await db.from('damaged_materials').insert({
            order_id: _damageOrderId || null,
            order_number: order?.order_number || null,
            item_id: itemId,
            item_name: itemName,
            quantity: damageQty,
            reason: reason,
            reported_by: reporterName
        }).select();
        if (logErr) throw new Error('ไม่สามารถบันทึกข้อมูลความเสียหายลงคลัง: ' + logErr.message);

        const dmgId = dmgData && dmgData[0] ? dmgData[0].id : null;

        // 3) Write to stock_movement_log — operator = ชื่อฝ่ายผลิต (แสดงใน outbound history)
        const dmgReasonStr = `วัสดุเสียหาย | source: production-damage | order_id: ${order?.id || _damageOrderId} | order_number: ${order?.order_number || _damageOrderId} | item: ${itemName} | note: ${reason}${dmgId ? ` | ref: ${dmgId}` : ''}`;
        const { error: movErr } = await db.from('stock_movement_log').insert({
            item_id: itemId,
            item_name: itemName,
            old_qty: currentQty,
            new_qty: newQty,
            operator: reporterName,
            reason: dmgReasonStr
        });
        if (movErr) throw new Error('ไม่สามารถบันทึกประวัติการปรับสต็อก: ' + movErr.message);

        // 4) Write to production_logs
        if (_damageOrderId) {
            await db.from('production_logs').insert({
                order_id: _damageOrderId,
                order_number: order?.order_number || '-',
                action: `⚠️ วัสดุเสียหาย: ${itemName} จำนวน ${damageQty} — ${reason} — ผู้รายงาน: ${reporterName}`
            });
        }

        log(`✅ บันทึกวัสดุเสียหาย: ${itemName} -${damageQty} (คงเหลือ ${newQty}) — โดย ${reporterName}`, 'success');
        closeDamageModal();
    } catch (err) {
        log(`❌ บันทึกไม่สำเร็จ: ${err.message}`, 'error');
        alert(`❌ เกิดข้อผิดพลาด: ${err.message}`);
    } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '⚠️ ยืนยันวัสดุเสียหาย'; }
    }
}

// ─── INIT ─────────────────────────────────
loadData();
setupRealtime();
