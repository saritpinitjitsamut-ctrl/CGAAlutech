const bomForm = document.getElementById('bomForm');
const formStatus = document.getElementById('formStatus');
const bomTableBody = document.getElementById('bomTableBody');
const bomCount = document.getElementById('bomCount');
const bomSearchInput = document.getElementById('bomSearch');
const refreshBtn = document.getElementById('refreshBtn');
const deleteBomBtn = document.getElementById('deleteBomBtn');
const clearBomBtn = document.getElementById('clearBomBtn');
const saveBomBtn = document.getElementById('saveBomBtn');
const bomParentSkuInput = document.getElementById('bomParentSku');
const bomParentSuggestionsEl = document.getElementById('bomParentSuggestions');
const componentsListEl = document.getElementById('componentsList');
const addComponentBtn = document.getElementById('addComponentBtn');

let dbClient = null;
let bomRows = [];
let selectedBomId = null;
let parentSearchTimer = null;
let componentNameMap = {};
let selectedBomParent = null;
let compRowCounter = 0;

function showStatus(message, type = 'success') {
    formStatus.textContent = message;
    formStatus.className = `status-message status-${type}`;
}

function clearStatus() {
    formStatus.textContent = '';
    formStatus.className = 'status-message';
}

function renderBomRows() {
    const term = (bomSearchInput.value || '').trim().toLowerCase();
    const filtered = bomRows.filter(row => {
        if (!term) return true;
        return [row.product_code, row.component_product_code].filter(Boolean).some(value => String(value).toLowerCase().includes(term));
    });

    bomCount.textContent = `${filtered.length} รายการ`;
    if (!filtered.length) {
        bomTableBody.innerHTML = '<tr><td colspan="4" class="empty-state">ไม่พบ BOM</td></tr>';
        return;
    }

    bomTableBody.innerHTML = filtered.map(row => {
        const componentName = componentNameMap[row.component_product_code] || '-';
        return `
        <tr data-bom-id="${row.id}" class="${selectedBomId === row.id ? 'active' : ''}">
            <td>${row.product_code}</td>
            <td>${row.component_product_code}</td>
            <td>${componentName}</td>
            <td>${row.component_qty}</td>
        </tr>
    `;
    }).join('');
}

async function loadBomRows() {
    if (!dbClient) {
        showStatus('ไม่สามารถเชื่อมต่อ Supabase ได้', 'error');
        return;
    }

    try {
        const { data, error } = await dbClient
            .from('stock_bom')
            .select('id, product_code, component_product_code, component_qty')
            .order('product_code', { ascending: true })
            .order('component_product_code', { ascending: true });

        if (error) throw error;
        bomRows = data || [];
        await loadComponentNames(bomRows.map(row => row.component_product_code));
        selectedBomId = null;
        renderBomRows();
    } catch (error) {
        console.error(error);
        showStatus(`โหลด BOM ล้มเหลว: ${error.message}`, 'error');
    }
}

async function loadComponentNames(codes) {
    componentNameMap = {};
    const uniqueCodes = Array.from(new Set(codes.filter(Boolean)));
    if (!uniqueCodes.length || !dbClient) return;

    try {
        const { data, error } = await dbClient
            .from('stock_items')
            .select('product_code, product_name')
            .in('product_code', uniqueCodes);
        if (error) throw error;
        (data || []).forEach(item => {
            componentNameMap[item.product_code] = item.product_name;
        });
    } catch (error) {
        console.warn('ไม่สามารถโหลดชื่อ SKU ชิ้นส่วนได้:', error);
    }
}

function resetBomForm(keepStatus = false) {
    bomForm.reset();
    selectedBomId = null;
    selectedBomParent = null;
    if (componentsListEl) componentsListEl.innerHTML = '';
    if (!keepStatus) clearStatus();
}

function setBomForm(row) {
    // Populate form for editing whole parent BOM
    const parent = row.product_code || '';
    bomParentSkuInput.value = parent;
    selectedBomParent = parent;
    // clear existing component rows
    if (componentsListEl) componentsListEl.innerHTML = '';
    // add all components for this parent
    const comps = bomRows.filter(r => r.product_code === parent);
    if (comps.length) {
        comps.forEach(c => addComponentRow({ code: c.component_product_code, name: componentNameMap[c.component_product_code] || '', qty: c.component_qty }));
    } else {
        addComponentRow();
    }
    selectedBomId = row.id;
    renderBomRows();
}

async function searchStockItems(query) {
    if (!dbClient || !query) return [];
    try {
        const { data, error } = await dbClient
            .from('stock_items')
            .select('product_code, product_name')
            .or(`product_code.ilike.%${query}%,product_name.ilike.%${query}%`)
            .order('product_code', { ascending: true })
            .limit(12);
        if (error) throw error;
        return data || [];
    } catch (error) {
        console.warn('ค้นหา stock_items ไม่สำเร็จ:', error);
        return [];
    }
}

function hideSuggestions() {
    if (bomParentSuggestionsEl) bomParentSuggestionsEl.classList.remove('show');
}

function addComponentRow(data = {}) {
    if (!componentsListEl) return;
    const id = `comp-${++compRowCounter}`;
    const wrapper = document.createElement('div');
    wrapper.className = 'component-row';
    wrapper.dataset.compId = id;
    wrapper.innerHTML = `
        <div class="comp-grid" style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
            <div style="flex:1">
                <input class="comp-code" placeholder="SKU \u0e0a\u0e34\u0e49\u0e19\u0e2a\u0e48\u0e27\u0e19" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;" />
                <div class="comp-suggestions" style="position:relative"></div>
            </div>
            <div style="flex:1">
                <input class="comp-name" placeholder="\u0e0a\u0e37\u0e48\u0e2d\u0e0a\u0e34\u0e49\u0e19\u0e2a\u0e48\u0e27\u0e19" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;" />
            </div>
            <div style="width:110px">
                <input class="comp-qty" type="number" min="1" value="1" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;" />
            </div>
            <div style="width:40px;text-align:center">
                <button type="button" class="btn-remove-comp" title="\u0e25\u0e1a\u0e23\u0e32\u0e22\u0e01\u0e32\u0e23">×</button>
            </div>
        </div>
    `;
    componentsListEl.appendChild(wrapper);

    const codeInput = wrapper.querySelector('.comp-code');
    const nameInput = wrapper.querySelector('.comp-name');
    const qtyInput = wrapper.querySelector('.comp-qty');
    const suggestionsEl = wrapper.querySelector('.comp-suggestions');
    const removeBtn = wrapper.querySelector('.btn-remove-comp');

    if (data.code) codeInput.value = data.code;
    if (data.name) nameInput.value = data.name;
    if (data.qty) qtyInput.value = data.qty;

    let rowTimer = null;
    codeInput.addEventListener('input', (e) => {
        const q = String(e.target.value || '').trim();
        if (rowTimer) clearTimeout(rowTimer);
        if (!q) { suggestionsEl.innerHTML = ''; suggestionsEl.classList.remove('show'); return; }
        rowTimer = setTimeout(async () => {
            const results = await searchStockItems(q);
            suggestionsEl.innerHTML = results.map(item => `
                <div class="suggestion-item" data-code="${item.product_code}" data-name="${item.product_name || ''}" style="padding:6px;border-bottom:1px solid rgba(0,0,0,0.03);cursor:pointer;">
                    <div style="font-weight:600">${item.product_code}</div>
                    <div style="font-size:12px;color:#666">${item.product_name || '-'}</div>
                </div>
            `).join('');
            suggestionsEl.classList.add('show');
        }, 220);
    });

    suggestionsEl.addEventListener('click', (ev) => {
        const it = ev.target.closest('.suggestion-item');
        if (!it) return;
        const c = it.dataset.code;
        const n = it.dataset.name || '';
        codeInput.value = c;
        nameInput.value = n;
        suggestionsEl.classList.remove('show');
    });

    removeBtn.addEventListener('click', () => {
        wrapper.remove();
    });
}

function getComponentsFromForm() {
    if (!componentsListEl) return [];
    const rows = Array.from(componentsListEl.querySelectorAll('.component-row'));
    return rows.map(r => {
        const code = (r.querySelector('.comp-code')?.value || '').trim();
        const name = (r.querySelector('.comp-name')?.value || '').trim();
        const qty = parseInt(r.querySelector('.comp-qty')?.value || '1') || 1;
        return { code, name, qty };
    }).filter(c => c.code);
}

function renderParentSuggestions(items) {
    if (!bomParentSuggestionsEl) return;
    if (!items || !items.length) {
        bomParentSuggestionsEl.classList.remove('show');
        bomParentSuggestionsEl.innerHTML = '';
        return;
    }

    bomParentSuggestionsEl.innerHTML = items.map(item => `
        <div class="suggestion-item" data-code="${item.product_code}" data-name="${item.product_name || ''}">
            <span class="suggestion-label">${item.product_code}</span>
            <span class="suggestion-subtitle">${item.product_name || '-'}</span>
        </div>
    `).join('');
    bomParentSuggestionsEl.classList.add('show');
}

function fillParentSku(code, name) {
    bomParentSkuInput.value = code;
    if (bomParentSuggestionsEl) bomParentSuggestionsEl.classList.remove('show');
}

async function searchParentSkus(query) {
    if (!dbClient || !query) return [];
    try {
        const { data, error } = await dbClient
            .from('sku_master')
            .select('product_code, name')
            .or(`product_code.ilike.%${query}%,name.ilike.%${query}%`)
            .order('product_code', { ascending: true })
            .limit(12);
        if (error) throw error;
        return (data || []).map(item => ({
            product_code: item.product_code,
            product_name: item.name || item.product_code
        }));
    } catch (error) {
        console.warn('ค้นหา sku_master ไม่สำเร็จ:', error);
        return [];
    }
}

async function handleParentSearchInput(event) {
    const query = String(event.target.value || '').trim();
    if (parentSearchTimer) clearTimeout(parentSearchTimer);
    if (!query) {
        if (bomParentSuggestionsEl) {
            bomParentSuggestionsEl.classList.remove('show');
            bomParentSuggestionsEl.innerHTML = '';
        }
        return;
    }

    parentSearchTimer = setTimeout(async () => {
        const results = await searchParentSkus(query);
        renderParentSuggestions(results);
    }, 240);
}

async function getStockItemByCode(productCode) {
    if (!dbClient || !productCode) return null;
    const { data, error } = await dbClient
        .from('stock_items')
        .select('id, product_name')
        .eq('product_code', productCode)
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return data;
}

async function getParentSkuByCode(productCode) {
    if (!dbClient || !productCode) return null;
    const { data, error } = await dbClient
        .from('sku_master')
        .select('product_code, name')
        .eq('product_code', productCode)
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return data;
}

async function ensureStockItemExists(productCode, productName) {
    const normalizedName = productName ? productName.trim() : '';
    const existing = await getStockItemByCode(productCode);
    if (existing) {
        if (normalizedName && existing.product_name !== normalizedName) {
            const { error } = await dbClient
                .from('stock_items')
                .update({ product_name: normalizedName })
                .eq('id', existing.id);
            if (error) throw error;
        }
        return existing;
    }

    const payload = {
        product_code: productCode,
        product_name: normalizedName || productCode,
        quantity: 0,
        unit: 'ชิ้น',
        category: 'general'
    };
    const { data, error } = await dbClient
        .from('stock_items')
        .insert([payload])
        .select('id, product_name')
        .single();
    if (error) throw error;
    return data;
}

async function saveBom(event) {
    event.preventDefault();
    clearStatus();
    const productCode = (bomParentSkuInput?.value || '').trim();
    if (!productCode) {
        showStatus('\u0e01\u0e23\u0e38\u0e13\u0e32\u0e01\u0e23\u0e2d\u0e01 SKU \u0e2b\u0e25\u0e31\u0e01', 'error');
        return;
    }

    try {
        const components = getComponentsFromForm();
        if (!components.length) {
            showStatus('\u0e01\u0e23\u0e38\u0e13\u0e32\u0e40\u0e1e\u0e34\u0e48\u0e21\u0e2d\u0e22\u0e48\u0e32\u0e07\u0e19\u0e49\u0e2d\u0e22 1 \u0e0a\u0e34\u0e49\u0e19\u0e2a\u0e48\u0e27\u0e19', 'error');
            return;
        }

        const parentSku = await getParentSkuByCode(productCode);
        if (!parentSku) {
            showStatus('\u0e44\u0e21\u0e48\u0e1e\u0e1a SKU \u0e2b\u0e25\u0e31\u0e01\u0e43\u0e19 sku_master \u0e01\u0e23\u0e38\u0e13\u0e32\u0e40\u0e25\u0e37\u0e2d\u0e01 SKU \u0e2b\u0e25\u0e31\u0e01\u0e08\u0e32\u0e01\u0e23\u0e32\u0e22\u0e01\u0e32\u0e23\u0e2a\u0e34\u0e19\u0e04\u0e49\u0e32', 'error');
            return;
        }

        // ensure each component exists (and update name if provided)
        for (const c of components) {
            await ensureStockItemExists(c.code, c.name);
        }

        // If editing an existing parent BOM, remove old rows for that parent
        if (selectedBomParent || selectedBomId) {
            const parentsToDelete = Array.from(new Set([selectedBomParent, productCode].filter(Boolean)));
            const { error: delErr } = await dbClient.from('stock_bom').delete().in('product_code', parentsToDelete);
            if (delErr) throw delErr;
        }

        const payloads = components.map(c => ({ product_code: productCode, component_product_code: c.code, component_qty: c.qty }));
        const { error } = await dbClient.from('stock_bom').insert(payloads);
        if (error) throw error;
        showStatus('\u0e40\u0e1e\u0e34\u0e48\u0e21/\u0e2d\u0e31\u0e1b\u0e40\u0e14\u0e15 BOM \u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08\u0e41\u0e25\u0e49\u0e27', 'success');

        resetBomForm(true);
        await loadBomRows();
    } catch (error) {
        console.error(error);
        showStatus(`\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01 BOM \u0e44\u0e21\u0e48\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08: ${error.message}`, 'error');
    }
}

async function deleteBom() {
    if (!selectedBomParent) {
        showStatus('\u0e01\u0e23\u0e38\u0e13\u0e32\u0e40\u0e25\u0e37\u0e2d\u0e01 BOM \u0e17\u0e35\u0e48\u0e15\u0e49\u0e2d\u0e07\u0e01\u0e32\u0e23\u0e25\u0e1a\u0e01\u0e48\u0e2d\u0e19', 'error');
        return;
    }

    const relatedRows = bomRows.filter(row => row.product_code === selectedBomParent);
    const relatedCount = relatedRows.length;
    if (!relatedCount) {
        showStatus('ไม่พบรายการ BOM ของ SKU หลักนี้แล้ว', 'error');
        return;
    }

    if (!confirm(`ยืนยันการลบ BOM ของ SKU หลัก ${selectedBomParent} จำนวน ${relatedCount} รายการ?`)) return;

    try {
        const { error } = await dbClient.from('stock_bom').delete().eq('product_code', selectedBomParent);
        if (error) throw error;
        showStatus('\u0e25\u0e1a BOM \u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08\u0e41\u0e25\u0e49\u0e27', 'success');
        resetBomForm(true);
        await loadBomRows();
    } catch (error) {
        console.error(error);
        showStatus(`\u0e25\u0e1a BOM \u0e44\u0e21\u0e48\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08: ${error.message}`, 'error');
    }
}

function clearBomForm() {
    resetBomForm();
    hideSuggestions();
}

function handleTableClick(event) {
    const row = event.target.closest('tr[data-bom-id]');
    if (!row) return;
    const id = Number(row.dataset.bomId);
    const bomRow = bomRows.find(item => item.id === id);
    if (!bomRow) return;
    setBomForm(bomRow);
}

function handleDocumentClick(event) {
    const target = event.target;
    const insideParent = bomParentSuggestionsEl && bomParentSuggestionsEl.contains(target);
    const isParentInput = target.id === 'bomParentSku';
    if (!insideParent && !isParentInput) {
        hideSuggestions();
    }
}

function initializePage() {
    dbClient = window.auth?.supabase || (window.supabase && window.SUPABASE_CONFIG
        ? window.supabase.createClient(window.SUPABASE_CONFIG.URL, window.SUPABASE_CONFIG.KEY)
        : null);

    if (!dbClient) {
        showStatus('ไม่พบ Supabase client กรุณาตรวจสอบ config.js', 'error');
        return;
    }

    bomForm.addEventListener('submit', saveBom);
    deleteBomBtn.addEventListener('click', deleteBom);
    clearBomBtn.addEventListener('click', clearBomForm);
    refreshBtn.addEventListener('click', loadBomRows);
    bomTableBody.addEventListener('click', handleTableClick);
    bomSearchInput.addEventListener('input', renderBomRows);
    // addComponent button
    if (addComponentBtn) addComponentBtn.addEventListener('click', () => addComponentRow());
    // Parent SKU autocomplete listeners
    if (bomParentSkuInput) {
        bomParentSkuInput.addEventListener('input', handleParentSearchInput);
    }
    if (bomParentSuggestionsEl) {
        bomParentSuggestionsEl.addEventListener('click', event => {
            const item = event.target.closest('.suggestion-item');
            if (!item) return;
            fillParentSku(item.dataset.code, item.dataset.name);
        });
    }
    document.addEventListener('click', handleDocumentClick);

    resetBomForm();
    // ensure there's at least one empty component row
    if (componentsListEl && !componentsListEl.querySelector('.component-row')) addComponentRow();
    loadBomRows();
}

document.addEventListener('DOMContentLoaded', initializePage);

