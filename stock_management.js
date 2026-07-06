// ==========================================
// STOCK MANAGEMENT SYSTEM — v2 (UX Improved)
// ==========================================

const STOCK_TABLE_NAME = 'stock_items';
let dbSupabase = null;
let allStocks = [];
let currentEditingId = null;
let sortField = 'created_at';
let sortAsc = false;
let realtimeChannel = null;
let movementLogs = [];

// ─── INIT ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    dbSupabase = (window.auth && window.auth.supabase)
        ? window.auth.supabase
        : (window.supabase && window.SUPABASE_CONFIG
            ? window.supabase.createClient(window.SUPABASE_CONFIG.URL, window.SUPABASE_CONFIG.KEY)
            : null);

    if (!dbSupabase) {
        showToast('❌ ไม่สามารถเชื่อมต่อฐานข้อมูลได้ — ตรวจสอบ config.js', 'error');
        return;
    }

    await refreshStockList();
    await loadMovementLogs();
    document.getElementById('stockForm').addEventListener('submit', handleFormSubmit);
    startRealtime();
});

// ─── TOAST NOTIFICATION ───────────────────────────────────────────────────
function showToast(msg, type = 'success') {
    const el = document.getElementById('toast');
    if (!el) return;
    const colors = {
        success: '#10b981',
        error: '#f87171',
        info: '#818cf8',
        warning: '#f59e0b'
    };
    el.style.background = `rgba(15,23,42,0.97)`;
    el.style.borderColor = colors[type] || colors.info;
    el.style.color = colors[type] || colors.info;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ─── REALTIME (Row-level) ─────────────────────────────────────────────────
function startRealtime() {
    if (!dbSupabase) return;
    realtimeChannel = dbSupabase
        .channel('stock-mgmt-realtime')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: STOCK_TABLE_NAME },
            ({ new: row }) => {
                // Add new row to local data without DB refetch
                if (!allStocks.find(s => s.id === row.id)) {
                    allStocks.unshift(row);
                }
                renderStockTable();
                updateStatistics();
                showToast(`➕ เพิ่มสินค้าใหม่: ${row.product_name}`, 'success');
            })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: STOCK_TABLE_NAME },
            ({ new: row }) => {
                // Patch only the changed row in local array
                const idx = allStocks.findIndex(s => s.id === row.id);
                if (idx !== -1) allStocks[idx] = row;
                else allStocks.unshift(row);

                // Update only the matching <tr> in the DOM
                const tr = document.querySelector(`tr[data-id="${row.id}"]`);
                if (tr) {
                    tr.outerHTML = buildRow(row);
                } else {
                    renderStockTable();
                }
                updateStatistics();
            })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: STOCK_TABLE_NAME },
            ({ old: row }) => {
                allStocks = allStocks.filter(s => s.id !== row.id);
                // Remove only that <tr>
                const tr = document.querySelector(`tr[data-id="${row.id}"]`);
                if (tr) tr.remove();
                else renderStockTable();
                updateStatistics();
                showToast(`🗑️ ลบสินค้า: ${row.product_name || row.id}`, 'info');
            })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'stock_movement_log' },
            () => {
                loadMovementLogs();
            })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'stock_movement_log' },
            () => {
                loadMovementLogs();
            })
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                showToast('🟢 เชื่อมต่อเรียลไทม์แล้ว', 'info');
                loadMovementLogs();
            }
        });
}

window.addEventListener('beforeunload', () => {
    if (realtimeChannel) dbSupabase.removeChannel(realtimeChannel);
});

// ─── LOAD DATA ────────────────────────────────────────────────────────────
async function refreshStockList() {
    try {
        const { data, error } = await dbSupabase
            .from(STOCK_TABLE_NAME)
            .select('*')
            .order('created_at', { ascending: false });
        if (error) throw error;
        allStocks = data || [];
        renderStockTable();
        updateStatistics();
    } catch (err) {
        showToast('❌ โหลดข้อมูลล้มเหลว: ' + err.message, 'error');
    }
}

// ─── SORT ─────────────────────────────────────────────────────────────────
function sortBy(field) {
    if (sortField === field) {
        sortAsc = !sortAsc;
    } else {
        sortField = field;
        sortAsc = true;
    }
    renderStockTable();
    // Update sort icons
    document.querySelectorAll('th[data-sort]').forEach(th => {
        const icon = th.querySelector('.sort-icon');
        if (!icon) return;
        if (th.dataset.sort === field) {
            icon.textContent = sortAsc ? ' ↑' : ' ↓';
        } else {
            icon.textContent = ' ↕';
        }
    });
}

// ─── RENDER TABLE ─────────────────────────────────────────────────────────
function getSorted(stocks) {
    return [...stocks].sort((a, b) => {
        let va = a[sortField] ?? '';
        let vb = b[sortField] ?? '';
        if (typeof va === 'number') return sortAsc ? va - vb : vb - va;
        return sortAsc
            ? String(va).localeCompare(String(vb), 'th')
            : String(vb).localeCompare(String(va), 'th');
    });
}

let selectedCategory = ''; // active tab category
let showOnlyLowStock = false;

function selectCategoryTab(element, category) {
    document.querySelectorAll('.category-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    element.classList.add('active');
    selectedCategory = category;
    renderStockTable();
}

function getFiltered() {
    const term = (document.getElementById('searchInput')?.value || '').toLowerCase();
    return allStocks.filter(s => {
        const matchName = s.product_name?.toLowerCase().includes(term) ||
                          (s.product_code || '').toLowerCase().includes(term);
        
        let matchCat = true;
        if (selectedCategory === 'spare_parts') {
            matchCat = s.category === 'general' || s.category === 'tools';
        } else if (selectedCategory) {
            matchCat = s.category === selectedCategory;
        }
        
        const isLow = s.quantity <= (s.reorder_point || 10);
        const matchLow = !showOnlyLowStock || isLow;
        
        return matchName && matchCat && matchLow;
    });
}

// ─── BUILD SINGLE ROW HTML ────────────────────────────────────────────────
function buildRow(stock) {
    const isLow = stock.quantity <= (stock.reorder_point || 10);
    const size  = (stock.width && stock.height)
        ? `${stock.width} × ${stock.height}`
        : (stock.width || stock.height || '—');
    const rowClass = isLow ? 'row-low' : '';
    const qtyClass = isLow ? 'qty-low' : 'qty-ok';

    return `
    <tr class="${rowClass}" data-id="${stock.id}">
        <td>${getCategoryLabel(stock.category)}</td>
        <td>
            <div class="product-name">${stock.product_name}</div>
            ${stock.product_code ? `<div class="product-code">${stock.product_code}</div>` : ''}
        </td>
        <td style="text-align: right; padding-right: 2rem;">
            <span class="qty-value ${qtyClass}">${stock.quantity}</span>
        </td>
        <td style="color:#64748b;">${stock.unit || '—'}</td>
        <td style="color:#64748b; font-size:0.85rem;">${size}</td>
        <td>
            <div class="qty-adjust-group" style="display: inline-flex; align-items: center; background: rgba(255, 255, 255, 0.03); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; padding: 2px;">
                ${window.auth && window.auth.role === 'Ceo'
                    ? `<button type="button" class="sign-toggle-btn" onclick="toggleSignBtn(this)" style="background: rgba(16, 185, 129, 0.15); border: none; color: #10b981; min-width: 30px; height: 28px; font-weight: bold; cursor: pointer; border-radius: 5px; font-family: monospace; transition: all 0.2s; font-size: 1rem; display: flex; align-items: center; justify-content: center; line-height: 1;" data-sign="+">+</button>`
                    : `<button type="button" class="sign-toggle-btn" style="background: rgba(16, 185, 129, 0.15); border: none; color: #10b981; min-width: 30px; height: 28px; font-weight: bold; cursor: not-allowed; border-radius: 5px; font-family: monospace; font-size: 1rem; display: flex; align-items: center; justify-content: center; line-height: 1;" data-sign="+" title="เฉพาะ CEO เท่านั้นที่สามารถหักสต็อกได้" disabled>+</button>`
                }
                <input class="quick-qty-input-new" type="number" min="1" placeholder="0" onkeydown="handleNewQuickQtyKeyDown(event, '${stock.id}', this)" style="border: none; background: transparent; width: 50px; color: var(--text); font-size: 0.9rem; text-align: center; padding: 0.3rem 0.2rem; outline: none; -moz-appearance: textfield;" title="ใส่จำนวนแล้วกด Enter เพื่อปรับสต็อก">
            </div>
        </td>
        <td>
            ${isLow
                ? `<span class="badge-low">⚠️ ต่ำ</span>`
                : `<span class="badge-ok">✅ พอดี</span>`}
        </td>
    </tr>`;
}

function renderStockTable() {
    const tbody = document.getElementById('stockTableBody');
    const emptyState = document.getElementById('emptyState');
    const stocks = getSorted(getFiltered());

    if (stocks.length === 0) {
        tbody.innerHTML = '';
        if (emptyState) emptyState.style.display = 'block';
        return;
    }
    if (emptyState) emptyState.style.display = 'none';

    tbody.innerHTML = stocks.map(buildRow).join('');
}



// ─── QUICK ADJUST QTY ─────────────────────────────────────────────────────
function toggleSignBtn(btn) {
    // Only CEO can switch to minus
    if (window.auth && window.auth.role !== 'Ceo') {
        showToast('🔒 เฉพาะ CEO เท่านั้นที่สามารถหักสต็อกได้', 'warning');
        return;
    }
    const curSign = btn.getAttribute('data-sign');
    if (curSign === '+') {
        btn.setAttribute('data-sign', '-');
        btn.textContent = '-';
        btn.style.background = 'rgba(239, 68, 68, 0.15)';
        btn.style.color = '#ef4444';
    } else {
        btn.setAttribute('data-sign', '+');
        btn.textContent = '+';
        btn.style.background = 'rgba(16, 185, 129, 0.15)';
        btn.style.color = '#10b981';
    }
}

async function handleNewQuickQtyKeyDown(e, id, inputEl) {
    if (e.key === 'Enter') {
        const val = inputEl.value.trim();
        if (!val) return;
        
        const qty = parseInt(val);
        if (isNaN(qty) || qty <= 0) {
            showToast('⚠️ กรุณากรอกจำนวนตัวเลขที่มากกว่า 0', 'warning');
            return;
        }
        
        // Find the sign sibling button
        const group = inputEl.closest('.qty-adjust-group');
        const toggleBtn = group.querySelector('.sign-toggle-btn');
        const sign = toggleBtn.getAttribute('data-sign') || '+';
        
        let delta = qty;
        if (sign === '-') {
            delta = -qty;
        }
        
        inputEl.disabled = true;
        await quickAdjust(id, delta);
        inputEl.disabled = false;
        inputEl.value = '';
        inputEl.focus();
    }
}

async function logStockMovement(itemId, itemName, oldQty, newQty, delta, userName, reason) {
    try {
        const { error } = await dbSupabase
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
            showToast('⚠️ ไม่สามารถบันทึกประวัติลง stock_movement_log ได้', 'warning');
        }
    } catch (err) {
        console.error('Catch error logging movement:', err);
    }
}

async function quickAdjust(id, delta) {
    const stock = allStocks.find(s => s.id === id);
    if (!stock) return;

    // Safety: non-CEO users cannot decrease stock
    if (delta < 0 && !(window.auth && window.auth.role === 'Ceo')) {
        showToast('🔒 เฉพาะ CEO เท่านั้นที่สามารถหักสต็อกได้', 'warning');
        return;
    }

    // ถาม 1: ชื่อ (บังคับ)
    const userName = prompt('👤 กรุณาระบุชื่อของคุณ (บังคับ):');
    if (!userName || !userName.trim()) {
        showToast('⚠️ ยกเลิก: จำเป็นต้องระบุชื่อผู้ปรับปรุง', 'warning');
        return;
    }

    // ถาม 2: เหตุผล (ไม่บังคับ — กด OK เปล่าได้)
    const reason = prompt('📝 เหตุผลในการปรับสต็อก (ระบุหรือเว้นว่างได้):');
    if (reason === null) {
        // กด Cancel บน dialog เหตุผล = ยกเลิกทั้งหมด
        showToast('⚠️ ยกเลิกการปรับจำนวน', 'warning');
        return;
    }

    const oldQty = stock.quantity;
    const newQty = Math.max(0, oldQty + delta);
    try {
        const { error } = await dbSupabase
            .from(STOCK_TABLE_NAME)
            .update({ quantity: newQty, updated_at: new Date().toISOString() })
            .eq('id', id);
        if (error) throw error;
        stock.quantity = newQty;

        const tr = document.querySelector(`tr[data-id="${id}"]`);
        if (tr) tr.outerHTML = buildRow(stock);
        else renderStockTable();

        updateStatistics();
        showToast(`✅ ${stock.product_name}: ${delta > 0 ? '+' : ''}${delta} → ${newQty} ${stock.unit || 'ชิ้น'}`, delta > 0 ? 'success' : 'warning');

        await logStockMovement(id, stock.product_name, oldQty, newQty, delta, userName, reason);
    } catch (err) {
        showToast('❌ ปรับจำนวนล้มเหลว: ' + err.message, 'error');
    }
}

// ─── SEARCH & FILTER ──────────────────────────────────────────────────────
function searchStocks() {
    renderStockTable();
}

function toggleLowStockFilter(active) {
    showOnlyLowStock = active;
    
    // Sync checkbox
    const checkbox = document.getElementById('lowStockCheckbox');
    if (checkbox) checkbox.checked = active;
    
    // Sync card style
    const card = document.getElementById('lowStockCard');
    if (card) {
        card.classList.toggle('selected', active);
    }
    
    // Sync label styling
    const label = document.getElementById('lowStockLabel');
    if (label) {
        if (active) {
            label.style.background = 'rgba(239, 68, 68, 0.2)';
            label.style.borderColor = 'var(--red)';
        } else {
            label.style.background = 'rgba(239, 68, 68, 0.08)';
            label.style.borderColor = 'rgba(239, 68, 68, 0.2)';
        }
    }
    
    renderStockTable();
}

function toggleLowStockFilterFromCard() {
    toggleLowStockFilter(!showOnlyLowStock);
}

// ─── STATISTICS ───────────────────────────────────────────────────────────
function updateStatistics() {
    const total    = allStocks.length;
    const lowStock = allStocks.filter(s => s.quantity <= (s.reorder_point || 10)).length;
    const totalQty = allStocks.reduce((sum, s) => sum + (s.quantity || 0), 0);

    document.getElementById('totalItems').textContent    = total;
    document.getElementById('lowStockItems').textContent = lowStock;
    document.getElementById('totalValue').textContent    = totalQty.toLocaleString('th-TH');
}

// ─── MODAL OPERATIONS ─────────────────────────────────────────────────────
let adjustMode = 'receive'; // 'receive' | 'issue'

function setAdjustMode(mode) {
    adjustMode = mode;
    document.getElementById('btnReceive').classList.toggle('selected', mode === 'receive');
    document.getElementById('btnIssue').classList.toggle('selected', mode === 'issue');
    const label = document.getElementById('deltaLabel');
    if (label) label.textContent = mode === 'receive' ? 'จำนวนที่รับเข้า *' : 'จำนวนที่จ่ายออก *';
}

function openAddModal() {
    currentEditingId = null;
    adjustMode = 'receive';
    document.getElementById('modalTitle').textContent = '➕ เพิ่มสินค้าใหม่';
    document.getElementById('stockForm').reset();
    
    // Show add section, hide edit section
    document.getElementById('addQtySection').style.display = '';
    document.getElementById('editQtySection').style.display = 'none';
    document.getElementById('quantity').required = true;
    document.getElementById('deltaQty').required = false;
    
    document.getElementById('stockModal').classList.add('active');
    document.getElementById('productName').focus();
}

async function openEditModal(id) {
    const stock = allStocks.find(s => s.id === id);
    if (!stock) return;
    currentEditingId = id;
    adjustMode = 'receive';
    document.getElementById('modalTitle').textContent = '✏️ แก้ไขข้อมูลสินค้า';
    document.getElementById('productName').value  = stock.product_name;
    document.getElementById('productCode').value  = stock.product_code || '';
    document.getElementById('category').value     = stock.category;
    document.getElementById('width').value        = stock.width || '';
    document.getElementById('height').value       = stock.height || '';
    
    // Adjust panel
    document.getElementById('unitEdit').value     = stock.unit || '';
    document.getElementById('currentQtyDisplay').textContent = stock.quantity;
    document.getElementById('currentQtyUnit').textContent    = stock.unit ? ' ' + stock.unit : ' ชิ้น';
    document.getElementById('deltaQty').value     = '';
    setAdjustMode('receive');
    
    // Hide add section, show edit section
    document.getElementById('addQtySection').style.display  = 'none';
    document.getElementById('editQtySection').style.display = '';
    document.getElementById('quantity').required = false;
    document.getElementById('deltaQty').required = true;
    
    document.getElementById('stockModal').classList.add('active');
    document.getElementById('deltaQty').focus();
}

function closeModal() {
    document.getElementById('stockModal').classList.remove('active');
    currentEditingId = null;
    document.getElementById('stockForm').reset();
}

// Close modal on backdrop click
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('stockModal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }
});

// ─── FORM SUBMISSION ──────────────────────────────────────────────────────
async function handleFormSubmit(e) {
    e.preventDefault();

    const submitBtn = document.getElementById('submitBtn') || e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ กำลังบันทึก...';

    try {
        if (currentEditingId) {
            // Edit Mode - adjust current quantity by delta
            const stock = allStocks.find(s => s.id === currentEditingId);
            const deltaRaw = parseInt(document.getElementById('deltaQty').value);
            if (isNaN(deltaRaw) || deltaRaw <= 0) {
                throw new Error('กรุณาระบุจำนวนสินค้าที่ต้องการปรับปรุงให้ถูกต้อง (ต้องมากกว่า 0)');
            }
            const delta = adjustMode === 'receive' ? deltaRaw : -deltaRaw;

            // ถาม 1: ชื่อ (บังคับ)
            const userName = prompt('👤 กรุณาระบุชื่อของคุณ (บังคับ):');
            if (!userName || !userName.trim()) {
                throw new Error('ยกเลิก: จำเป็นต้องระบุชื่อผู้ปรับปรุงเพื่อบันทึกประวัติ');
            }

            // ถาม 2: เหตุผล (ไม่บังคับ)
            const reason = prompt('📝 เหตุผลในการปรับสต็อก (ระบุหรือเว้นว่างได้):');
            if (reason === null) {
                throw new Error('ยกเลิกการปรับจำนวน');
            }
            const oldQty = stock?.quantity || 0;
            const newQty = Math.max(0, oldQty + delta);
            const unit = document.getElementById('unitEdit').value.trim() || null;

            const updateData = {
                product_name: document.getElementById('productName').value.trim(),
                product_code: document.getElementById('productCode').value.trim() || null,
                category:     document.getElementById('category').value,
                unit:         unit,
                quantity:     newQty,
                width:        document.getElementById('width').value  ? parseFloat(document.getElementById('width').value)  : null,
                height:       document.getElementById('height').value ? parseFloat(document.getElementById('height').value) : null,
                updated_at:   new Date().toISOString()
            };

            const { error } = await dbSupabase
                .from(STOCK_TABLE_NAME)
                .update(updateData)
                .eq('id', currentEditingId);
            if (error) throw error;
            
            const sign = delta > 0 ? '+' : '';
            showToast(`✅ ${updateData.product_name}: ${sign}${delta} → คงเหลือ ${newQty} ${unit || 'ชิ้น'}`, adjustMode === 'receive' ? 'success' : 'warning');

            // Log movement to stock_movement_log
            await logStockMovement(currentEditingId, updateData.product_name, oldQty, newQty, delta, userName, reason);
        } else {
            // Add Mode - create new item
            const qtyVal = document.getElementById('quantity').value;
            const formData = {
                product_name: document.getElementById('productName').value.trim(),
                product_code: document.getElementById('productCode').value.trim() || null,
                category:     document.getElementById('category').value,
                quantity:     qtyVal ? parseInt(qtyVal) : 0,
                unit:         document.getElementById('unit').value.trim() || null,
                width:        document.getElementById('width').value  ? parseFloat(document.getElementById('width').value)  : null,
                height:       document.getElementById('height').value ? parseFloat(document.getElementById('height').value) : null,
            };
            
            const { error } = await dbSupabase
                .from(STOCK_TABLE_NAME)
                .insert([formData]);
            if (error) throw error;
            showToast('✅ เพิ่มสินค้าเรียบร้อย', 'success');
        }
        closeModal();
        await refreshStockList();
    } catch (err) {
        showToast('❌ บันทึกล้มเหลว: ' + err.message, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '💾 บันทึก';
    }
}

// ─── DELETE ───────────────────────────────────────────────────────────────
async function deleteStock(id) {
    const stock = allStocks.find(s => s.id === id);
    if (!stock) return;
    if (!confirm(`ลบ "${stock.product_name}" ออกจากสต็อก?\n\nการกระทำนี้ไม่สามารถย้อนกลับได้`)) return;
    try {
        const { error } = await dbSupabase
            .from(STOCK_TABLE_NAME)
            .delete()
            .eq('id', id);
        if (error) throw error;
        showToast('🗑️ ลบสินค้าเรียบร้อย', 'info');
        await refreshStockList();
    } catch (err) {
        showToast('❌ ลบล้มเหลว: ' + err.message, 'error');
    }
}

// ─── UTILITIES ────────────────────────────────────────────────────────────
function getCategoryLabel(cat) {
    if (cat === 'general' || cat === 'tools') {
        return `<span class="tag-category tools">🔩 อะไหล่</span>`;
    }
    if (cat === 'glass') {
        return `<span class="tag-category glass">💠 กระจก</span>`;
    }
    if (cat === 'aluminum') {
        return `<span class="tag-category aluminum">📐 อลูมิเนียม</span>`;
    }
    return `<span class="tag-category">${cat}</span>`;
}

// ─── LOGS FETCHING & RENDERING ────────────────────────────────────────────
async function loadMovementLogs() {
    if (!dbSupabase) return;
    try {
        const { data, error } = await dbSupabase
            .from('stock_movement_log')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(500);
        if (error) throw error;
        movementLogs = data || [];
        if (movementLogs.length > 0) {
            console.log("LOG KEYS FOUND:", Object.keys(movementLogs[0]));
            console.log("LOG SAMPLE ROW:", movementLogs[0]);
        } else {
            console.log("LOG: No movement logs found");
        }
        renderLogs();
    } catch (err) {
        console.error("Error loading movement logs:", err);
    }
}

function getLocalDateString(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function renderLogs() {
    const receiveLogBody = document.getElementById('receiveLogBody');
    const issueLogBody = document.getElementById('issueLogBody');
    if (!receiveLogBody || !issueLogBody) return;

    const receiveTerm = (document.getElementById('receiveSearchInput')?.value || '').toLowerCase().trim();
    const issueTerm = (document.getElementById('issueSearchInput')?.value || '').toLowerCase().trim();

    const receiveDateStart = document.getElementById('receiveDateStart')?.value || '';
    const receiveDateEnd = document.getElementById('receiveDateEnd')?.value || '';
    const issueDateStart = document.getElementById('issueDateStart')?.value || '';
    const issueDateEnd = document.getElementById('issueDateEnd')?.value || '';

    // Filter receives (delta > 0)
    let receives = movementLogs.filter(l => (l.delta ?? 0) > 0);
    if (receiveTerm) {
        receives = receives.filter(l => 
            (l.item_name || '').toLowerCase().includes(receiveTerm) ||
            (l.operator || '').toLowerCase().includes(receiveTerm) ||
            (l.reason || '').toLowerCase().includes(receiveTerm)
        );
    }
    if (receiveDateStart) {
        receives = receives.filter(l => getLocalDateString(l.created_at) >= receiveDateStart);
    }
    if (receiveDateEnd) {
        receives = receives.filter(l => getLocalDateString(l.created_at) <= receiveDateEnd);
    }

    // Filter issues (delta < 0)
    let issues = movementLogs.filter(l => (l.delta ?? 0) < 0);
    if (issueTerm) {
        issues = issues.filter(l => 
            (l.item_name || '').toLowerCase().includes(issueTerm) ||
            (l.dispatched_by || '').toLowerCase().includes(issueTerm) ||
            (l.operator || '').toLowerCase().includes(issueTerm) ||
            (l.reason || '').toLowerCase().includes(issueTerm)
        );
    }
    if (issueDateStart) {
        issues = issues.filter(l => getLocalDateString(l.created_at) >= issueDateStart);
    }
    if (issueDateEnd) {
        issues = issues.filter(l => getLocalDateString(l.created_at) <= issueDateEnd);
    }

    // Render Receives (IN)
    if (receives.length === 0) {
        receiveLogBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--muted); padding:2rem;">ไม่มีประวัติการรับเข้า</td></tr>`;
    } else {
        receiveLogBody.innerHTML = receives.map(l => {
            const dateStr  = new Date(l.created_at).toLocaleString('th-TH', { hour12: false });
            const opName   = l.operator || '—';
            const reason   = l.reason || '—';
            return `
            <tr>
                <td style="color:#64748b; font-size:0.8rem;">${dateStr}</td>
                <td style="font-weight:500; color:var(--text);">${l.item_name}</td>
                <td style="text-align:right; font-weight:bold; color:#10b981; padding-right:1.5rem;">+${l.delta}</td>
                <td style="color:#94a3b8;">${opName}</td>
                <td style="color:#94a3b8; font-size:0.9rem;">${reason}</td>
            </tr>`;
        }).join('');
    }

    // Render Issues (OUT)
    if (issues.length === 0) {
        issueLogBody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--muted); padding:2rem;">ไม่มีประวัติการจ่ายออก</td></tr>`;
    } else {
        issueLogBody.innerHTML = issues.map(l => {
            const dateStr  = new Date(l.created_at).toLocaleString('th-TH', { hour12: false });
            const dispatcher = l.dispatched_by || '—';
            const producer   = l.operator || '—';
            const reason     = l.reason || '—';
            return `
            <tr>
                <td style="color:#64748b; font-size:0.8rem;">${dateStr}</td>
                <td style="font-weight:500; color:var(--text);">${l.item_name}</td>
                <td style="text-align:right; font-weight:bold; color:#f87171; padding-right:1.5rem;">${l.delta}</td>
                <td style="color:#94a3b8;">${dispatcher}</td>
                <td style="color:#94a3b8;">${producer}</td>
                <td style="color:#94a3b8; font-size:0.9rem;">${reason}</td>
            </tr>`;
        }).join('');
    }
}

// ─── SECTION TAB SWITCHING ────────────────────────────────────────────────
function switchSectionTab(tabId) {
    document.querySelectorAll('.section-panel').forEach(panel => {
        panel.style.display = 'none';
    });
    document.querySelectorAll('.section-tab').forEach(tab => {
        tab.classList.remove('active');
    });

    const targetPanel = document.getElementById(`panel-${tabId}`);
    if (targetPanel) {
        targetPanel.style.display = 'block';
    }
    const targetTab = document.getElementById(`tab-${tabId}`);
    if (targetTab) {
        targetTab.classList.add('active');
    }
}

