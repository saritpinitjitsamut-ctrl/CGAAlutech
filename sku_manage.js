const SKU_REF = window.SKU_REFERENCE;
if (!SKU_REF) throw new Error('ไม่พบข้อมูลอ้างอิง SKU กรุณาตรวจสอบ sku_reference.js');

const PRODUCT_TYPES = SKU_REF.productTypes;
const PANEL_OPTIONS = SKU_REF.panels;
const DIMENSIONS = SKU_REF.dimensions;
const FRAME_COLORS = SKU_REF.frameColors;
const GLASS_COLORS = SKU_REF.glassColors;
const PATTERNS = SKU_REF.patterns;

const skuForm = document.getElementById('skuForm');
const statusEl = document.getElementById('formStatus');
const skuTableBody = document.getElementById('skuTableBody');
const skuCountEl = document.getElementById('skuCount');
const skuSearchInput = document.getElementById('skuSearch');
const submitBtn = document.getElementById('submitBtn');
const deleteBtn = document.getElementById('deleteBtn');
const resetBtn = document.getElementById('resetBtn');
const newSkuBtn = document.getElementById('newSkuBtn');
const productCodeInput = document.getElementById('productCode');
const nameInput = document.getElementById('name');
const productPrefixSelect = document.getElementById('productPrefix');
const heightSelect = document.getElementById('heightCode');
const widthSelect = document.getElementById('widthCode');
const sizeInput = document.getElementById('size');
const slotsInput = document.getElementById('slots');
const patternCodeSelect = document.getElementById('patternCode');
const patternInput = document.getElementById('pattern');
const frameColorSelect = document.getElementById('frameColor');
const glassColorSelect = document.getElementById('glassColor');
const netSelect = document.getElementById('netId');

let dbClient = null;
let skuRows = [];
let selectedProductCode = null;

function showStatus(message, type = 'success') {
    statusEl.textContent = message;
    statusEl.className = `status-message status-${type}`;
}

function clearStatus() {
    statusEl.textContent = '';
    statusEl.className = 'status-message';
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function setOptions(selectEl, items, placeholder) {
    const currentValue = selectEl.value;
    selectEl.innerHTML = `<option value="">${placeholder}</option>`;
    items.forEach(item => {
        const option = document.createElement('option');
        option.value = item.value;
        option.textContent = item.label;
        Object.entries(item.dataset || {}).forEach(([key, value]) => {
            option.dataset[key] = String(value);
        });
        selectEl.appendChild(option);
    });
    if (currentValue && Array.from(selectEl.options).some(option => option.value === currentValue)) {
        selectEl.value = currentValue;
    }
}

function getSelectedOption(selectEl) {
    return selectEl.options[selectEl.selectedIndex] || null;
}

function loadExcelReferenceOptions() {
    const productPrefixes = PRODUCT_TYPES.flatMap(type => PANEL_OPTIONS.map(panel => ({
        value: `${type.code}${panel.code}`,
        label: `${type.code}${panel.code} - ${type.name} ${panel.count} บาน`,
        dataset: {
            productName: type.name,
            panelCount: panel.count
        }
    })));

    const dimensions = DIMENSIONS.map(item => ({
        value: item.code,
        label: `${item.size} (${item.code})`,
        dataset: { size: item.size }
    }));

    setOptions(productPrefixSelect, productPrefixes, '-- เลือกประเภทสินค้า --');
    setOptions(heightSelect, dimensions, '-- เลือกความสูง --');
    setOptions(widthSelect, dimensions, '-- เลือกความกว้าง --');
    setOptions(frameColorSelect, FRAME_COLORS.map(item => ({
        value: item.code,
        label: `${item.code} - ${item.name}`,
        dataset: { colorName: item.name }
    })), '-- เลือกสีกรอบ --');
    setOptions(glassColorSelect, GLASS_COLORS.map(item => ({
        value: item.code,
        label: `${item.code} - ${item.name}`,
        dataset: { colorName: item.name }
    })), '-- เลือกสีกระจก --');
    setOptions(patternCodeSelect, PATTERNS.map(item => ({
        value: item.dbCode,
        label: `${item.skuCode} - ${item.name}`,
        dataset: { skuCode: item.skuCode, patternName: item.name }
    })), '-- เลือกลาย --');
}

function inferNetSkuCode(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (normalized === 'x' || normalized === 'ไม่มีมุ้ง' || normalized.includes('ไม่มีมุ้ง')) return 'X';
    if (normalized === 'n' || normalized === 'มีมุ้ง' || normalized.includes('มีมุ้ง')) return 'N';
    return '';
}

async function loadNetOptions() {
    const { data, error } = await dbClient
        .from('mosquito_nets')
        .select('net_id, net_status')
        .order('net_id', { ascending: true });
    if (error) throw error;

    const options = (data || []).map(item => {
        const skuCode = inferNetSkuCode(item.net_status);
        return {
            value: String(item.net_id),
            label: `${skuCode || item.net_status} - ${skuCode === 'N' ? 'มีมุ้ง' : (skuCode === 'X' ? 'ไม่มีมุ้ง' : item.net_status)}`,
            dataset: {
                skuCode,
                netName: skuCode === 'N' ? 'มีมุ้ง' : (skuCode === 'X' ? 'ไม่มีมุ้ง' : item.net_status)
            }
        };
    });
    setOptions(netSelect, options, '-- เลือกสถานะมุ้ง --');
}

function buildAutoName() {
    const prefixOption = getSelectedOption(productPrefixSelect);
    const heightOption = getSelectedOption(heightSelect);
    const widthOption = getSelectedOption(widthSelect);
    const frameOption = getSelectedOption(frameColorSelect);
    const glassOption = getSelectedOption(glassColorSelect);
    const netOption = getSelectedOption(netSelect);
    const patternOption = getSelectedOption(patternCodeSelect);

    if (!productPrefixSelect.value || !heightSelect.value || !widthSelect.value) return '';
    const parts = [
        prefixOption?.dataset.productName,
        `${prefixOption?.dataset.panelCount || slotsInput.value} บาน`,
        `ขนาด ${heightOption?.dataset.size}x${widthOption?.dataset.size}`,
        frameColorSelect.value ? `กรอบ${frameOption?.dataset.colorName}` : '',
        glassColorSelect.value ? `กระจก${glassOption?.dataset.colorName}` : '',
        netOption?.dataset.netName,
        patternOption?.dataset.patternName
    ];
    return parts.filter(Boolean).join(' ');
}

function updateGeneratedFields() {
    const prefixOption = getSelectedOption(productPrefixSelect);
    const heightOption = getSelectedOption(heightSelect);
    const widthOption = getSelectedOption(widthSelect);
    const netOption = getSelectedOption(netSelect);
    const patternOption = getSelectedOption(patternCodeSelect);

    slotsInput.value = prefixOption?.dataset.panelCount || '1';
    sizeInput.value = heightSelect.value && widthSelect.value
        ? `${heightOption?.dataset.size}x${widthOption?.dataset.size}`
        : '';
    patternInput.value = patternOption?.dataset.patternName || '';

    const prefixMatch = /^(.*?)(\d+)P$/.exec(productPrefixSelect.value);
    productCodeInput.value = prefixMatch ? SKU_REF.buildProductCode({
        productType: prefixMatch[1],
        panelCount: Number(prefixMatch[2]),
        height: heightOption?.dataset.size,
        width: widthOption?.dataset.size,
        frameColor: frameColorSelect.value,
        glassColor: glassColorSelect.value,
        net: netOption?.dataset.skuCode,
        pattern: patternOption?.dataset.skuCode
    }) : '';

    if (nameInput.dataset.autoGenerated === 'true') {
        nameInput.value = buildAutoName();
    }
}

function resetForm() {
    skuForm.reset();
    selectedProductCode = null;
    nameInput.dataset.autoGenerated = 'true';
    slotsInput.value = '1';
    document.getElementById('price').value = '0';
    productCodeInput.value = '';
    sizeInput.value = '';
    patternInput.value = '';
    clearStatus();
    renderSkuRows();
    productPrefixSelect.focus();
}

function renderSkuRows() {
    const term = (skuSearchInput.value || '').trim().toLowerCase();
    const filtered = skuRows.filter(row => {
        if (!term) return true;
        return [row.product_code, row.name, row.size, row.product_prefix, row.pattern]
            .filter(Boolean)
            .some(value => String(value).toLowerCase().includes(term));
    });

    skuCountEl.textContent = `${filtered.length} รายการ`;
    if (!filtered.length) {
        skuTableBody.innerHTML = '<tr><td colspan="4" class="empty-state">ไม่พบข้อมูล SKU</td></tr>';
        return;
    }

    skuTableBody.innerHTML = filtered.map(row => `
        <tr data-product-code="${escapeHtml(row.product_code)}" class="${selectedProductCode === row.product_code ? 'active' : ''}">
            <td>${escapeHtml(row.product_code || '-')}</td>
            <td>${escapeHtml(row.name || '-')}</td>
            <td>${escapeHtml(row.size || '-')}</td>
            <td>${row.price != null ? Number(row.price).toLocaleString('th-TH', { maximumFractionDigits: 2 }) : '-'}</td>
        </tr>
    `).join('');
}

async function loadSkus() {
    if (!dbClient) {
        showStatus('ไม่สามารถเชื่อมต่อ Supabase ได้', 'error');
        return;
    }

    try {
        const { data, error } = await dbClient
            .from('sku_master')
            .select('product_code, name, size, slots, price, product_prefix, pattern, pattern_code, frame_color_code, glass_color_code, net_id')
            .order('product_code', { ascending: true });
        if (error) throw error;
        skuRows = data || [];
        renderSkuRows();
    } catch (error) {
        console.error(error);
        showStatus(`โหลด SKU ไม่สำเร็จ: ${error.message}`, 'error');
    }
}

function parseProductCode(productCode) {
    const parsed = SKU_REF.parseProductCode(productCode);
    if (!parsed) return null;
    return {
        prefix: parsed.productPrefix,
        heightCode: parsed.heightCode,
        widthCode: parsed.widthCode,
        frameCode: parsed.frameColor,
        glassCode: parsed.glassColor,
        netSkuCode: parsed.net,
        patternDbCode: parsed.patternCode
    };
}

function selectNetBySkuCode(skuCode) {
    const option = Array.from(netSelect.options).find(item => item.dataset.skuCode === skuCode);
    netSelect.value = option?.value || '';
}

async function loadSelectedSku(productCode) {
    if (!dbClient || !productCode) return;
    try {
        const { data, error } = await dbClient
            .from('sku_master')
            .select('product_code, name, size, slots, price, product_prefix, pattern, pattern_code, frame_color_code, glass_color_code, net_id')
            .eq('product_code', productCode)
            .maybeSingle();
        if (error) throw error;
        if (!data) return;

        const parsed = parseProductCode(data.product_code);
        productPrefixSelect.value = data.product_prefix || parsed?.prefix || '';
        heightSelect.value = parsed?.heightCode || '';
        widthSelect.value = parsed?.widthCode || '';
        frameColorSelect.value = data.frame_color_code || parsed?.frameCode || '';
        glassColorSelect.value = data.glass_color_code || parsed?.glassCode || '';
        const storedPatternCode = String(data.pattern_code ?? parsed?.patternDbCode ?? '');
        patternCodeSelect.value = storedPatternCode === 'X1'
            ? '6'
            : storedPatternCode.replace(/^L/i, '');
        netSelect.value = data.net_id != null ? String(data.net_id) : '';
        if (!netSelect.value && parsed?.netSkuCode) selectNetBySkuCode(parsed.netSkuCode);

        nameInput.dataset.autoGenerated = 'false';
        updateGeneratedFields();
        productCodeInput.value = data.product_code || productCodeInput.value;
        nameInput.value = data.name || buildAutoName();
        sizeInput.value = data.size || sizeInput.value;
        slotsInput.value = data.slots || slotsInput.value;
        document.getElementById('price').value = data.price ?? '0';
        patternInput.value = data.pattern || patternInput.value;
        selectedProductCode = data.product_code;
        renderSkuRows();
    } catch (error) {
        console.error(error);
        showStatus(`โหลดรายละเอียด SKU ไม่สำเร็จ: ${error.message}`, 'error');
    }
}

async function ensureSelectedLookups() {
    const prefixOption = getSelectedOption(productPrefixSelect);
    const frameOption = getSelectedOption(frameColorSelect);
    const glassOption = getSelectedOption(glassColorSelect);
    const patternOption = getSelectedOption(patternCodeSelect);

    const requests = [
        dbClient.from('products').upsert([{
            product_prefix: productPrefixSelect.value,
            product_name: `${prefixOption.dataset.productName} ${prefixOption.dataset.panelCount} บาน`
        }], { onConflict: 'product_prefix' }),
        dbClient.from('aluminum_colors').upsert([{
            color_code: frameColorSelect.value,
            color_name: frameOption.dataset.colorName
        }], { onConflict: 'color_code' }),
        dbClient.from('glass_colors').upsert([{
            color_code: glassColorSelect.value,
            color_name: glassOption.dataset.colorName
        }], { onConflict: 'color_code' }),
        dbClient.from('patterns').upsert([{
            pattern_code: patternCodeSelect.value,
            pattern_name: patternOption.dataset.patternName
        }], { onConflict: 'pattern_code' })
    ];

    const results = await Promise.all(requests);
    const failed = results.find(result => result.error);
    if (failed?.error) throw failed.error;
}

async function handleSubmit(event) {
    event.preventDefault();
    clearStatus();
    updateGeneratedFields();

    if (!dbClient) {
        showStatus('ไม่สามารถเชื่อมต่อ Supabase ได้', 'error');
        return;
    }

    const payload = {
        product_code: productCodeInput.value.trim(),
        name: nameInput.value.trim(),
        product_prefix: productPrefixSelect.value || null,
        size: sizeInput.value.trim(),
        slots: Number(slotsInput.value || 1),
        pattern: patternInput.value.trim() || null,
        pattern_code: patternCodeSelect.value || null,
        price: Number(document.getElementById('price').value || 0),
        net_id: netSelect.value ? Number(netSelect.value) : null,
        frame_color_code: frameColorSelect.value || null,
        glass_color_code: glassColorSelect.value || null
    };

    if (!payload.product_code || !payload.name || !payload.size || !payload.net_id) {
        showStatus('กรุณาเลือกข้อมูล SKU ให้ครบทุกช่อง', 'error');
        return;
    }
    if (selectedProductCode && selectedProductCode !== payload.product_code) {
        showStatus('ไม่สามารถเปลี่ยนรหัสของ SKU เดิมได้ กรุณากด “SKU ใหม่” เพื่อสร้างรายการใหม่', 'error');
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'กำลังบันทึก...';
    try {
        await ensureSelectedLookups();
        const { error } = await dbClient.from('sku_master').upsert([payload], { onConflict: 'product_code' });
        if (error) throw error;
        showStatus('บันทึก SKU สำเร็จแล้ว', 'success');
        selectedProductCode = payload.product_code;
        nameInput.dataset.autoGenerated = 'false';
        await loadSkus();
        await loadSelectedSku(payload.product_code);
    } catch (error) {
        console.error(error);
        showStatus(`บันทึกไม่สำเร็จ: ${error.message}`, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '💾 บันทึก SKU';
    }
}

async function handleDelete() {
    const code = productCodeInput.value.trim();
    if (!code || !confirm(`ลบ SKU ${code} จริงหรือไม่?`)) return;

    try {
        const { error } = await dbClient.from('sku_master').delete().eq('product_code', code);
        if (error) throw error;
        resetForm();
        showStatus('ลบ SKU สำเร็จแล้ว', 'success');
        await loadSkus();
    } catch (error) {
        console.error(error);
        showStatus(`ลบ SKU ไม่สำเร็จ: ${error.message}`, 'error');
    }
}

async function initializePage() {
    dbClient = window.auth?.supabase || (window.supabase && window.SUPABASE_CONFIG
        ? window.supabase.createClient(window.SUPABASE_CONFIG.URL, window.SUPABASE_CONFIG.KEY)
        : null);
    if (!dbClient) {
        showStatus('ไม่พบ Supabase client กรุณาตรวจสอบ config.js', 'error');
        return;
    }

    loadExcelReferenceOptions();
    try {
        await loadNetOptions();
    } catch (error) {
        console.error(error);
        showStatus(`โหลดข้อมูลมุ้งไม่สำเร็จ: ${error.message}`, 'error');
    }

    [productPrefixSelect, heightSelect, widthSelect, frameColorSelect, glassColorSelect, netSelect, patternCodeSelect]
        .forEach(element => element.addEventListener('change', updateGeneratedFields));
    nameInput.addEventListener('input', () => {
        nameInput.dataset.autoGenerated = 'false';
    });
    skuForm.addEventListener('submit', handleSubmit);
    deleteBtn.addEventListener('click', handleDelete);
    newSkuBtn.addEventListener('click', resetForm);
    resetBtn.addEventListener('click', event => {
        event.preventDefault();
        resetForm();
    });
    skuSearchInput.addEventListener('input', renderSkuRows);
    skuTableBody.addEventListener('click', event => {
        const row = event.target.closest('tr[data-product-code]');
        if (!row) return;
        selectedProductCode = row.dataset.productCode;
        renderSkuRows();
        loadSelectedSku(selectedProductCode);
    });

    resetForm();
    await loadSkus();
}

document.addEventListener('DOMContentLoaded', initializePage);
