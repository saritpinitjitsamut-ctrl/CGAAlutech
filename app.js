// ==========================================
// CONFIGURATION - Shared with auth.js
// ==========================================
// Identifiers like SUPABASE_URL are managed by auth.js to prevent conflicts
const SUPABASE_TABLE_NAME = 'stock_orders';

// ==========================================
// DEBUG LOGGER
// ==========================================
function log(msg, type = 'info') {
    const logDiv = document.getElementById('statusLog');
    if (logDiv) {
        logDiv.style.display = 'block';
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        logDiv.prepend(entry);
    }
    console.log(`[${type}] ${msg}`);
}

window.onerror = function(message, source, lineno, colno, error) {
    log(`Runtime Error: ${message} at ${lineno}:${colno}`, 'error');
    return false;
};

const ALLOWED_GLASS_COLORS = ['ใส', 'เขียวตัดแสง', 'ชาดำ', 'ฝ้า'];
const ALLOWED_SCREEN_TYPES = ['มีมุ้ง', 'ไม่มีมุ้ง'];

const mosquitoNetCache = {};
const aluminumColorCache = {};
const glassColorCache = {};

async function resolveColorName(colorCode, type = 'aluminum') {
    const normalized = normalizeString(colorCode);
    if (!normalized || !dbSupabase) return null;
    
    const cache = type === 'glass' ? glassColorCache : aluminumColorCache;
    const tableName = type === 'glass' ? 'glass_colors' : 'aluminum_colors';
    
    if (cache[normalized]) return cache[normalized];

    try {
        const { data, error } = await dbSupabase.from(tableName).select('color_name').eq('color_code', normalized).maybeSingle();
        if (error) {
            log(`❌ ไม่สามารถอ่านชื่อสีจาก ${tableName}: ${error.message}`, 'error');
            return null;
        }
        const colorName = data?.color_name || null;
        if (colorName) cache[normalized] = colorName;
        return colorName;
    } catch (e) {
        log(`❌ เกิดข้อผิดพลาดขณะอ่าน ${tableName}: ${e.message}`, 'error');
        return null;
    }
}

async function resolveMosquitoNetStatus(netIdOrStatus) {
    if (netIdOrStatus === null || netIdOrStatus === undefined) return null;
    const normalized = String(netIdOrStatus).trim();
    if (normalized === '') return null;
    if (mosquitoNetCache[normalized]) return mosquitoNetCache[normalized];

    // ถ้าเป็นค่าตัวอักษร x/n ให้ตีความเป็น net_status โดยตรง
    if (normalized.toLowerCase() === 'x') {
        mosquitoNetCache[normalized] = 'ไม่มีมุ้ง';
        return 'ไม่มีมุ้ง';
    }
    if (normalized.toLowerCase() === 'n') {
        mosquitoNetCache[normalized] = 'มีมุ้ง';
        return 'มีมุ้ง';
    }

    try {
        let query = dbSupabase.from('mosquito_nets').select('net_status');
        const asNumber = Number(normalized);
        if (!Number.isNaN(asNumber) && Number.isInteger(asNumber)) {
            query = query.eq('net_id', asNumber);
        } else {
            query = query.eq('net_status', normalized);
        }
        const { data, error } = await query.maybeSingle();
        if (error) {
            log(`❌ ไม่สามารถอ่าน net_status จาก mosquito_nets: ${error.message}`, 'error');
            return null;
        }
        const status = data?.net_status || null;
        mosquitoNetCache[normalized] = status;
        return status;
    } catch (e) {
        log(`❌ เกิดข้อผิดพลาดขณะอ่าน mosquito_nets: ${e.message}`, 'error');
        return null;
    }
}

function normalizeString(value) {
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim();
    return normalized === '' ? null : normalized;
}

function normalizeGlassColor(value) {
    const normalized = normalizeString(value);
    if (!normalized) return null;
    if (ALLOWED_GLASS_COLORS.includes(normalized)) return normalized;

    const lower = normalized.toLowerCase();
    const cleaned = lower.replace(/\(.*?\)/g, '').replace(/[^a-zก-๙0-9]+/g, ' ').trim();
    const tokens = cleaned.split(' ').filter(Boolean);

    const lookup = {
        'clear': 'ใส',
        'transparent': 'ใส',
        'ใส': 'ใส',
        'c': 'ใส',
        'green': 'เขียวตัดแสง',
        'g': 'เขียวตัดแสง',
        'เขียว': 'เขียวตัดแสง',
        'เขียวตัดแสง': 'เขียวตัดแสง',
        'tea': 'ชาดำ',
        't': 'ชาดำ',
        'b': 'ชาดำ',
        'ชา': 'ชาดำ',
        'ชาดำ': 'ชาดำ',
        'frost': 'ฝ้า',
        'matte': 'ฝ้า',
        'f': 'ฝ้า',
        'ฝ้า': 'ฝ้า'
    };

    for (const token of tokens) {
        if (lookup[token]) {
            return lookup[token];
        }
    }

    if (lower.includes('ใส')) return 'ใส';
    if (lower.includes('เขียว')) return 'เขียวตัดแสง';
    if (lower.includes('ชา')) return 'ชาดำ';
    if (lower.includes('ฝ้า')) return 'ฝ้า';

    return null;
}

function normalizeScreenType(value) {
    const normalized = normalizeString(value);
    if (!normalized) return null;
    if (ALLOWED_SCREEN_TYPES.includes(normalized)) return normalized;

    const lookup = {
        'yes': 'มีมุ้ง',
        'y': 'มีมุ้ง',
        'n': 'มีมุ้ง',
        'มี': 'มีมุ้ง',
        'no': 'ไม่มีมุ้ง',
        'x': 'ไม่มีมุ้ง',
        'ไม่มี': 'ไม่มีมุ้ง'
    };

    return lookup[normalized.toLowerCase()] || null;
}

// Initialize Supabase Client
// Use the existing client from auth.js if available
let dbSupabase = (window.auth && window.auth.supabase) ? window.auth.supabase : null; 

try {
    if (!dbSupabase) {
        log("กำลังเตรียมการเชื่อมต่อ Supabase ใหม่...");
        // Fallback: ใช้ค่าจาก config.js ที่ถูก gitignore (อ่านไว้ใน window.SUPABASE_CONFIG)
        if (window.supabase && window.SUPABASE_CONFIG) {
            dbSupabase = window.supabase.createClient(window.SUPABASE_CONFIG.URL, window.SUPABASE_CONFIG.KEY);
            log("เชื่อมต่อ Supabase สำเร็จ (Client Ready)", "success");
        } else if (!window.SUPABASE_CONFIG) {
            log("ไม่พบ config.js — กรุณาสร้างไฟล์ config.js ก่อนใช้งาน (ดูตัวอย่างจาก config.example.js)", "error");
        } else {
            log("ไม่พบ Supabase Library ในระบบ", "error");
        }
    } else {
        log("ใช้งานการเชื่อมต่อ Supabase จาก Auth System", "success");
    }
} catch (e) {
    log(`Supabase Init Failed: ${e.message}`, "error");
}

document.addEventListener('DOMContentLoaded', () => {
    log("หน้าเว็บ (UI) โหลดเสร็จสมบูรณ์");
    
    // Set default date to today
    const orderDateInput = document.getElementById('orderDate');
    if (orderDateInput) orderDateInput.valueAsDate = new Date();

    const form = document.getElementById('stockForm');
    const submitBtn = document.getElementById('submitBtn');
    
    if (!submitBtn) {
        log("ไม่พบปุ่มบันทึก (submitBtn) ในหน้าเว็บ", "error");
        return;
    }

    // ==========================================
    // AUTOFILL PRODUCT DATA BY SKU
    // ==========================================
    const productCodeInput = document.getElementById('productCode');
    const productFetchStatus = document.getElementById('productFetchStatus');
    const btnFetchSku = document.getElementById('btnFetchSku');
    
    async function fetchSkuData() {
        if (!productCodeInput || !dbSupabase) return;
        const code = productCodeInput.value.trim();
        if (!code) {
            if (productFetchStatus) productFetchStatus.textContent = '';
            return;
        }
        
        if (productFetchStatus) {
            productFetchStatus.textContent = '⏳ กำลังค้นหาข้อมูล...';
            productFetchStatus.style.color = '#fbbf24';
        }
        
        try {
            const { data, error } = await dbSupabase
                .from('sku_master')
                .select('*, frame_color:aluminum_colors!sku_master_frame_color_fkey(color_name), glass_color:glass_colors!sku_master_glass_color_fkey(color_name), glass_color_code, net_id')
                .ilike('product_code', code)
                .maybeSingle(); 
                
            if (error) throw error;
            
            if (data) {
                if (productFetchStatus) {
                    productFetchStatus.textContent = '✅ พบข้อมูลสินค้า';
                    productFetchStatus.style.color = '#34d399';
                }
                
                const skuName = data.name || '';
                const skuPattern = data.pattern || '';
                if (skuName) document.getElementById('productName').value = skuName;
                if (data.size) document.getElementById('productSize').value = data.size;
                if (data.slots != null) document.getElementById('slots').value = data.slots;
                if (data.price != null) document.getElementById('price').value = data.price;
                
                // เติมช่องลายอัตโนมัติ
                const patternInput = document.getElementById('pattern');
                if (patternInput) patternInput.value = skuPattern;

                // เติมสีอลูมิเนียม, สีกระจก (ใช้ชื่อสีจาก JOIN)
                const aluminumEl = document.getElementById('aluminum_color');
                const aluminumName = data.frame_color?.color_name || data.frame_color_code || null;
                if (aluminumEl && aluminumName) aluminumEl.value = aluminumName;
                const glassEl = document.getElementById('glass_color');
                const glassName = data.glass_color?.color_name || data.glass_color_code || null;
                if (glassEl) {
                    let normalizedGlass = normalizeGlassColor(glassName);
                    if (!normalizedGlass && data.glass_color_code) {
                        const resolvedGlassName = await resolveColorName(data.glass_color_code, 'glass');
                        normalizedGlass = normalizeGlassColor(resolvedGlassName || data.glass_color_code);
                    }
                    if (normalizedGlass) {
                        glassEl.value = normalizedGlass;
                    } else {
                        log(`⚠️ ไม่สามารถแปลงค่าสีกระจก '${glassName}' เป็นค่าที่รองรับ`, 'warn');
                    }
                }

                // เติมประเภทมุ้งจาก net_id โดย query ตาราง mosquito_nets แยกต่างหาก
                const screenEl = document.getElementById('screen_type');
                if (screenEl) {
                    const netStatus = await resolveMosquitoNetStatus(data.net_id);
                    const screenName = netStatus || normalizeScreenType(data.net_id) || null;
                    screenEl.value = normalizeScreenType(screenName) || '';
                }

                log(`ดึงข้อมูลสำเร็จ: ${skuName} | ไซส์: ${data.size} | ช่อง: ${data.slots} | ลาย: ${skuPattern || 'ไม่มี'}`, 'success');
            } else {
                if (productFetchStatus) {
                    productFetchStatus.textContent = '⚠️ ไม่พบรหัสนี้ในฐานข้อมูล (SKU Master)';
                    productFetchStatus.style.color = '#f87171'; // Red to make it obvious
                }
            }
        } catch (err) {
            console.error("Autofill Error: ", err);
            if (productFetchStatus) {
                productFetchStatus.textContent = '❌ ค้นหาล้มเหลว (อาจเป็นที่สิทธิ์ของฐานข้อมูล)';
                productFetchStatus.style.color = '#f87171';
            }
        }
    }

    if (productCodeInput) {
        productCodeInput.addEventListener('blur', fetchSkuData);
        productCodeInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); fetchSkuData(); }
        });
    }
    if (btnFetchSku) {
        btnFetchSku.addEventListener('click', fetchSkuData);
    }

    log("กำลังติดตั้งระบบปุ่มบันทึก...");
    submitBtn.addEventListener('click', async (e) => {
        log("มีการคลิกปุ่มบันทึก (Manual Save Clicked)");
        e.preventDefault();

        if (!form || !form.checkValidity()) {
            log("ตรวจสอบล้มเหลว: ข้อมูลในฟอร์มไม่ครบถ้วน", "error");
            alert('❌ กรุณากรอกข้อมูลในช่องที่มีเครื่องหมายจำเป็นให้ครบถ้วนก่อนกดบันทึกครับ');
            if (form) form.reportValidity();
            return;
        }

        const btnText = submitBtn.querySelector('.btn-text');
        const btnLoader = submitBtn.querySelector('.btn-loader');
        const statusMessage = document.getElementById('statusMessage');

        // UI Loading state
        submitBtn.disabled = true;
        if (btnText) btnText.style.display = 'none';
        if (btnLoader) btnLoader.style.display = 'inline';
        if (statusMessage) {
            statusMessage.className = 'status-message';
            statusMessage.style.display = 'none';
        }

        log("กำลังอ่านข้อมูลจากฟอร์ม...");
        try {
            const orderNumber = document.getElementById('orderNumber').value.trim();
            const trackingNumber = document.getElementById('trackingNumber') ? document.getElementById('trackingNumber').value.trim() : null;

            if (!dbSupabase) throw new Error("Supabase Client ไม่พร้อมทำงาน");

            // --- ตรวจสอบเลขพัสดุซ้ำก่อนบันทึก (Manual) ---
            if (trackingNumber && trackingNumber !== '-') {
                log("กำลังตรวจสอบเลขพัสดุซ้ำในฐานข้อมูล...");
                const { data: existingTracking, error: trackingError } = await dbSupabase
                    .from(SUPABASE_TABLE_NAME)
                    .select('id')
                    .eq('tracking_number', trackingNumber);
                if (trackingError) throw trackingError;

                if (existingTracking && existingTracking.length > 0) {
                    log("พบเลขพัสดุซ้ำ! ยกเลิกการบันทึก", "error");
                    alert("❌ เลขพัสดุนี้มีอยู่แล้วในระบบครับ (เลขพัสดุห้ามซ้ำ)");
                    return;
                }
            }

            // -- เริ่มระบบอัปโหลดรูปภาพ (ถ้ามี) --
            const bookImageInput = document.getElementById('bookImage');
            let uploadedImageUrl = null;
            
            if (bookImageInput && bookImageInput.files.length > 0) {
                const file = bookImageInput.files[0];
                const fileExt = file.name.split('.').pop();
                const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
                
                log(`กำลังอัปโหลดรูปภาพใบbook: ${fileName}`);
                if (statusMessage) {
                    statusMessage.textContent = 'กำลังอัปโหลดรูปภาพใบbook... ⏳';
                    statusMessage.style.display = 'block';
                    statusMessage.className = 'status-message';
                }

                const { data: uploadData, error: uploadError } = await dbSupabase
                    .storage
                    .from('book_images')
                    .upload(fileName, file);

                if (uploadError) {
                    log(`อัปโหลดรูปภาพล้มเหลว: ${uploadError.message}`, "error");
                    throw new Error(`อัปโหลดรูปล้มเหลว: ${uploadError.message}`);
                }

                const { data: publicUrlData } = dbSupabase
                    .storage
                    .from('book_images')
                    .getPublicUrl(fileName);

                uploadedImageUrl = publicUrlData.publicUrl;
                log(`อัปโหลดรูปภาพสำเร็จ: ${uploadedImageUrl}`, "success");
            }

            const formData = {
                order_date: document.getElementById('orderDate').value,
                platform: document.getElementById('platform').value,
                order_number: orderNumber,
                product_code: document.getElementById('productCode').value || null,
                product_name: document.getElementById('productName').value,
                product_size: document.getElementById('productSize').value || null,
                slots: document.getElementById('slots').value ? parseInt(document.getElementById('slots').value) : null,
                quantity: parseInt(document.getElementById('quantity').value),
                price: parseFloat(document.getElementById('price').value),
                shipping_fee: parseFloat(document.getElementById('shippingFee').value || 0),
                buyer_name: document.getElementById('buyerName').value,
                address: document.getElementById('address').value || null,
                province: document.getElementById('province').value,
                tracking_status: document.getElementById('status').value,
                book_image_url: uploadedImageUrl,
                note: document.getElementById('note') ? document.getElementById('note').value || null : null,
                tracking_number: trackingNumber,
                courier_phone: document.getElementById('courier_phone') ? document.getElementById('courier_phone').value || null : null,
                latest_location: document.getElementById('latest_location') ? document.getElementById('latest_location').value || null : null,
                pattern: document.getElementById('pattern') ? document.getElementById('pattern').value || null : null,
                aluminum_color: document.getElementById('aluminum_color') ? document.getElementById('aluminum_color').value || null : null,
                glass_color: normalizeGlassColor(document.getElementById('glass_color') ? document.getElementById('glass_color').value : null),
                screen_type: normalizeScreenType(document.getElementById('screen_type') ? document.getElementById('screen_type').value : null)
            };
            log(`รวบรวมข้อมูลสำเร็จ: ${formData.order_number}`);
            
            log("กำลังส่งข้อมูลไปที่ Supabase Database...");
            const { data, error } = await dbSupabase
                .from(SUPABASE_TABLE_NAME)
                .insert([formData]);

            if (error) throw error;

            log("บันทึกลง Supabase สำเร็จ!", "success");
            if (statusMessage) {
                statusMessage.textContent = '✅ บันทึกข้อมูลสำเร็จ!';
                statusMessage.style.display = 'block';
                statusMessage.className = 'status-message status-success';
            }
            
            form.reset();
            if (orderDateInput) orderDateInput.valueAsDate = new Date();
            document.getElementById('platform').value = "";
            document.getElementById('status').value = "รอดำเนินการ";
            if (bookImageInput) bookImageInput.value = "";
            const pcInput = document.getElementById('productCode');
            if (pcInput) pcInput.value = "";
            const noteInput = document.getElementById('note');
            if (noteInput) noteInput.value = "";
            const trackingInput = document.getElementById('trackingNumber');
            if (trackingInput) trackingInput.value = "";
            const patternInput2 = document.getElementById('pattern');
            if (patternInput2) patternInput2.value = "";

        } catch (error) {
            log(`บันทึกไม่สำเร็จ: ${error.message}`, "error");
            if (statusMessage) {
                statusMessage.style.display = 'block';
                statusMessage.textContent = `❌ เกิดข้อผิดพลาด: ${error.message}`;
                statusMessage.className = 'status-message status-error';
            }
            alert(`ข้อผิดพลาดการบันทึก: ${error.message}`);
        } finally {
            submitBtn.disabled = false;
            if (btnText) btnText.style.display = 'inline';
            if (btnLoader) btnLoader.style.display = 'none';
        }
    });

    // ==========================================
    // EXCEL / CSV BULK UPLOAD SYSTEM
    // ==========================================
    const manualTabBtn = document.getElementById('manualTabBtn');
    const uploadTabBtn = document.getElementById('uploadTabBtn');

    if (manualTabBtn && uploadTabBtn) {
        log("กำลังติดตั้งระบบสลับแท็บ...");
        manualTabBtn.addEventListener('click', () => {
            manualTabBtn.classList.add('active');
            uploadTabBtn.classList.remove('active');
            document.getElementById('manualSection').style.display = 'block';
            document.getElementById('uploadSection').style.display = 'none';
        });
        uploadTabBtn.addEventListener('click', () => {
            uploadTabBtn.classList.add('active');
            manualTabBtn.classList.remove('active');
            document.getElementById('manualSection').style.display = 'none';
            document.getElementById('uploadSection').style.display = 'block';
        });
    }

    const fileInput = document.getElementById('fileInput');
    const dropZone = document.getElementById('dropZone');
    let parsedDataToUpload = [];

    if (dropZone) {
        log("กำลังติดตั้งระบบลากวางไฟล์...");
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            if (e.dataTransfer.files.length) {
                fileInput.files = e.dataTransfer.files;
                handleFileSelect(e.dataTransfer.files[0]);
            }
        });
    }

    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length) handleFileSelect(e.target.files[0]);
        });
    }

    function handleFileSelect(file) {
        log(`เลือกไฟล์: ${file.name}`);
        document.getElementById('fileNameDisplay').innerHTML = `✅ เลือกไฟล์แล้ว:<br><span style="font-size: 0.9rem; color: #cbd5e1;">${file.name}</span>`;
        const reader = new FileReader();
        const dropZone = document.getElementById('dropZone');
        const fileNameDisplay = document.getElementById('fileNameDisplay');
        const originalText = fileNameDisplay ? fileNameDisplay.innerHTML : "";
        
        reader.onload = async function(e) {
            try {
                if (dropZone) dropZone.classList.add('processing');
                log("กำลังอ่านไฟล์ Excel...");
                // Yield to allow UI to show the log
                await new Promise(r => setTimeout(r, 100));
                
                const data = new Uint8Array(e.target.result);
                log(`อ่าน Buffer สำเร็จ (${data.length} bytes) กำลังถอดรหัส...`);
                // Yield again
                await new Promise(r => setTimeout(r, 50));
                
                const workbook = XLSX.read(data, {type: 'array'});
                log("ถอดรหัส Workbook สำเร็จ");
                
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];
                const rawData = XLSX.utils.sheet_to_json(worksheet, {defval: ""});
                
                log(`ประมวลผลเป็น JSON สำเร็จ (${rawData.length} แถว)`);
                // Final yielding before business logic
                await new Promise(r => setTimeout(r, 50));
                
                if (rawData.length === 0) {
                    log("ไม่พบข้อมูลในไฟล์", "error");
                    alert('ไม่พบข้อมูลในไฟล์ หรือไฟล์ผิดรูปแบบ');
                    if (dropZone) dropZone.classList.remove('processing');
                    return;
                }
                
                log(`เริ่มวิเคราะห์ข้อมูล...`);
                await processExcelData(rawData);
                log("วิเคราะห์ข้อมูลเสร็จสิ้น", "success");
            } catch (err) {
                log(`ล้มเหลว: ${err.message}`, "error");
                alert(`เกิดข้อผิดพลาดในการประมวลผล: ${err.message}`);
                console.error(err);
            } finally {
                if (dropZone) dropZone.classList.remove('processing');
            }
        };
        reader.readAsArrayBuffer(file);
    }

    function extractSkuFromName(name) {
        if (!name) return null;
        // มองหารูปแบบ SKU เช่น BKH-BK-50-40-GK ที่ซ่อนอยู่ในชื่อสินค้า 
        // โดยใช้รูปแบบ (ภาษาอังกฤษ/ตัวเลข) ติดกับ (-)
        const match = String(name).match(/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)/);
        return match ? match[1] : null;
    }

    function extractSizeAndSlots(itemName) {
        if (!itemName) return { size: null, slots: null };
        let size = null, slots = null;
        const sizeMatch = String(itemName).match(/size\s*([a-zA-Z0-9]+)|ขนาด\s*([a-zA-Z0-9]+)|\b([SML]|XL|XXL|XXXL)\b/i);
        if (sizeMatch) size = sizeMatch[1] || sizeMatch[2] || sizeMatch[3];
        const slotMatch = String(itemName).match(/(\d+)\s*ช่อง/);
        if (slotMatch) slots = parseInt(slotMatch[1]);
        return { size: size ? size.toUpperCase() : null, slots };
    }

    // Global header cache to speed up lookups across thousands of rows
    let headerMapCache = new Map();

    function getValue(row, keys, precalcRowKeys = null) {
        // Try exact matches first for speed
        for (let k of keys) {
            if (row[k] !== undefined && row[k] !== null && row[k] !== '') return String(row[k]).trim();
        }

        // Use cached mapping for fuzzy matches (case-insensitive)
        const rowKeys = precalcRowKeys || Object.keys(row);
        for (let k of keys) {
            const normalizedK = k.toLowerCase().trim();
            
            // Check cache
            if (headerMapCache.has(normalizedK)) {
                const cachedKey = headerMapCache.get(normalizedK);
                if (row[cachedKey] !== undefined && row[cachedKey] !== null && row[cachedKey] !== '') {
                    return String(row[cachedKey]).trim();
                }
            }

            // Fallback to fuzzy search and update cache
            const foundKey = rowKeys.find(rk => rk.toLowerCase().trim() === normalizedK);
            if (foundKey) {
                headerMapCache.set(normalizedK, foundKey);
                if (row[foundKey] !== undefined && row[foundKey] !== null && row[foundKey] !== '') {
                    return String(row[foundKey]).trim();
                }
            }
        }
        return null;
    }

    async function processExcelData(rawData) {
        log("กำลังเริ่มวิเคราะห์ข้อมูล...");
        headerMapCache.clear(); // Reset cache for new file
        
        // Pruning: กรองเอาเฉพาะแถวที่มีข้อมูลจริงๆ ป้องกันเคส Excel มีหมื่นแถว "หลอก"
        const cleanData = rawData.filter(row => {
            const vals = Object.values(row);
            return vals.length > 0 && vals.some(v => v !== "" && v !== null && v !== undefined);
        });
        
        if (cleanData.length === 0) {
            log("ไม่พบแถวข้อมูลที่ใช้งานได้ในไฟล์นี้", "error");
            alert("ไม่พบข้อมูลในไฟล์");
            return;
        }
        
        log(`วิเคราะห์พบแถวข้อมูลจริง ${cleanData.length} รายการ (จากทั้งหมด ${rawData.length} แถว)`);

        const headers = Object.keys(cleanData[0]);
        const isLazada = headers.some(h => h.toLowerCase().includes('lazada') || h.toLowerCase().includes('createtime'));
        const isShopee = headers.some(h => h.includes('วันที่ทำการสั่งซื้อ'));
        const isTikTok = headers.some(h => h.toLowerCase().includes('created time'));
        let platform = isLazada ? 'Lazada' : (isShopee ? 'Shopee' : (isTikTok ? 'TikTok' : 'Other'));
        log(`ตรวจพบแพลตฟอร์ม: ${platform}`);
        
        // 1. รวบรวม SKU และ ชื่อสินค้า เพื่อจะไปดึงทีเดียว
        const skusToFetch = [];
        const namesToFetch = [];
        cleanData.forEach(row => {
            const rowKeys = Object.keys(row);
            let pCode = null, pName = "";
            if (platform === 'Lazada') { 
                pCode = getValue(row, ['sellerSku'], rowKeys); 
                pName = getValue(row, ['itemName'], rowKeys); 
            }
            if (platform === 'Shopee') { 
                pCode = getValue(row, ['เลขอ้างอิง Parent SKU', 'เลขอ้างอิง SKU (SKU Reference No.)', 'Parent SKU', 'SKU'], rowKeys); 
                pName = getValue(row, ['ชื่อสินค้า'], rowKeys); 
            }
            if (platform === 'TikTok') { 
                pCode = getValue(row, ['Seller SKU', 'SKU ID'], rowKeys); 
                pName = getValue(row, ['Product Name'], rowKeys); 
            }
            
            pCode = pCode || extractSkuFromName(pName);
            if (pCode) skusToFetch.push(pCode);
            if (pName) namesToFetch.push(pName);
        });

        let masterDict = {};
        if (typeof dbSupabase !== 'undefined' && dbSupabase) {
            log("กำลังเชื่อมต่อ SKU Master เพื่อตรวจสอบราคาและขนาด...");
            try {
                // Optimized Fetch Function: Chunking to avoid URL length limits
                async function fetchInChunks(column, values) {
                    const uniqueValues = [...new Set(values)].filter(v => v);
                    const total = uniqueValues.length;
                    if (total === 0) return [];
                    
                    // ใช้ Chunk Size เล็กๆ สำหรับ Name/name_ref เพราะชื่อสินค้ายาวมาก
                    const chunkSize = (column === 'name' || column === 'name_ref') ? 1 : 40; 
                    let results = [];
                    log(`🔍 ค้นหา ${column} ในฐานข้อมูล: ${total} รายการ...`);
                    
                    for (let i = 0; i < total; i += chunkSize) {
                        const originalChunk = uniqueValues.slice(i, i + chunkSize).map(v => v.trim());
                        
                        // ป้องกันชื่อยาวเกินไปจนทำระบบค้าง
                        if ((column === 'name' || column === 'name_ref') && originalChunk[0].length > 200) {
                            log(`   - ข้ามการค้นหาชื่อที่ยาวเกินไป (${originalChunk[0].length} ตัวอักษร)`);
                            continue;
                        }

                        const robustChunk = [...new Set([
                            ...originalChunk,
                            ...originalChunk.map(v => v.toUpperCase()),
                            ...originalChunk.map(v => v.toLowerCase())
                        ])];
                        
                        try {
                            const selectFields = '*, frame_color:aluminum_colors!sku_master_frame_color_fkey(color_name), glass_color:glass_colors!sku_master_glass_color_fkey(color_name), glass_color_code, net_id';
                            const { data, error } = await dbSupabase.from('sku_master')
                                .select(selectFields)
                                .in(column, robustChunk);
                            
                            if (error) {
                                log(`❌ ชุดที่ ${Math.floor(i/chunkSize) + 1} ผิดพลาด: ${error.message}`, 'error');
                            } else if (data) {
                                results = results.concat(data);
                            }
                        } catch (pkgErr) {
                            log(`❌ ชุดที่ ${Math.floor(i/chunkSize) + 1} ล้มเหลว (Network Error)`, 'error');
                        }
                        
                        // Yield to UI
                        await new Promise(r => setTimeout(r, 0));
                    }
                    log(`✅ ดึงข้อมูล ${column} สำเร็จ (พบ ${results.length} รายการ)`);
                    return results;
                }

                // Fetch by SKU Code
                if (skusToFetch.length > 0) {
                    const skusData = await fetchInChunks('product_code', skusToFetch);
                    skusData.forEach(item => {
                        if (item.product_code) {
                            const key = 'CODE_' + String(item.product_code).toLowerCase().trim();
                            masterDict[key] = item;
                        }
                    });
                }

                // Fetch by Product Name (รองรับเฉพาะ column 'name' ตาม schema ปัจจุบัน)
                if (namesToFetch.length > 0) {
                    const namesData = await fetchInChunks('name', namesToFetch);
                    namesData.forEach(item => {
                        const itemName = item.name;
                        if (itemName) {
                            const key = 'NAME_' + String(itemName).toLowerCase().trim();
                            masterDict[key] = item;
                        }
                    });
                }
                
                log("ตรวจสอบข้อมูล SKU Master เสร็จสมบูรณ์", "success");
            } catch (err) {
                log(`Master Fetch Error: ${err.message}`, "error");
                console.error("Master Fetch Error:", err);
            }
        }

        parsedDataToUpload = [];
        let matchCount = 0;
        
        // ใช้ for...of เพื่อให้สามารถใช้ await เพื่อ "พัก" ให้ UI ทำงานได้
        for (let i = 0; i < cleanData.length; i++) {
            const row = cleanData[i];
            const rowKeys = Object.keys(row);
            let date = new Date().toISOString().split('T')[0];
            let orderNumber = `UNK-${i}`, trackingNumber = null, courierPhone = null, latestLocation = null, bookImageUrl = null, productCode = null, productName = "Unknown", quantity = 1, price = 0, shipping = 0, buyer = "Unknown", address = null, province = "Unknown", status = "รอดำเนินการ", note = null;
            
            if (platform === 'Lazada') {
                const dateRaw = getValue(row, ['createTime'], rowKeys);
                if (dateRaw) { try { date = new Date(dateRaw).toISOString().split('T')[0]; } catch(e){} }
                orderNumber = getValue(row, ['orderItemId', 'orderNumber', 'orderId'], rowKeys) || orderNumber;
                trackingNumber = getValue(row, ['trackingCode', 'cdTrackingCode', 'trackingNumber', 'tracking_number'], rowKeys);
                productCode = getValue(row, ['sellerSku', 'sku', 'SKU'], rowKeys) || productCode;
                productName = getValue(row, ['itemName', 'productName', 'ชื่อสินค้า'], rowKeys) || productName;
                quantity = parseInt(getValue(row, ['quantity', 'productQuantity'], rowKeys) || 1);
                price = parseFloat(getValue(row, ['unitPrice', 'paidPrice'], rowKeys) || 0);
                shipping = parseFloat(getValue(row, ['shippingFee'], rowKeys) || 0);
                // ข้อมูลคนซื้อ (ให้เช็ค billing ก่อนเพราะบางที shipping ถูก Mask)
                buyer = getValue(row, ['billingName', 'shippingName', 'customerName'], rowKeys) || buyer;
                address = getValue(row, ['billingAddr', 'shippingAddress', 'billingAddress'], rowKeys);
                // จังหวัดใน Lazada มักอยู่ใน shippingAddress3 หรือ billingAddr3
                province = getValue(row, ['shippingAddress3', 'billingAddr3', 'shippingAddress4', 'billingAddr4'], rowKeys) || province;
                
                note = getValue(row, ['sellerNote', 'buyerMessage', 'หมายเหตุ'], rowKeys) || note;
                bookImageUrl = getValue(row, ['book_image_url', 'รูปภาพ', 'รูปใบ Book', 'Image', 'Photo', 'URL'], rowKeys);
                courierPhone = getValue(row, ['courier_phone', 'เบอร์ขนส่ง', 'เบอร์โทรขนส่ง', 'Courier Phone'], rowKeys);
                latestLocation = getValue(row, ['latest_location', 'สถานที่ล่าสุด', 'สาขาล่าสุด', 'Location'], rowKeys);
            } else if (platform === 'Shopee') {
                const dateRaw = getValue(row, ['วันที่ทำการสั่งซื้อ'], rowKeys);
                if (dateRaw) date = dateRaw.split(' ')[0];
                orderNumber = getValue(row, ['หมายเลขคำสั่งซื้อ'], rowKeys) || orderNumber;
                productCode = getValue(row, ['เลขอ้างอิง Parent SKU', 'เลขอ้างอิง SKU (SKU Reference No.)', 'Parent SKU', 'SKU', 'sku'], rowKeys) || productCode;
                productName = getValue(row, ['ชื่อสินค้า', 'productName', 'Product Name'], rowKeys) || productName;
                quantity = parseInt(getValue(row, ['จำนวน'], rowKeys) || 1);
                price = parseFloat(getValue(row, ['จำนวนเงินทั้งหมด', 'ยอดรวม'], rowKeys) || 0);
                shipping = parseFloat(getValue(row, ['ค่าจัดส่งที่ชำระโดยผู้ซื้อ', 'ค่าจัดส่ง', 'Shipping Fee', 'shipping fee'], rowKeys) || 0);
                buyer = getValue(row, ['ชื่อผู้ใช้ (ผู้ซื้อ)'], rowKeys) || buyer;
                address = getValue(row, ['ที่อยู่', 'ที่อยู่ในการจัดส่ง'], rowKeys);
                province = getValue(row, ['จังหวัด'], rowKeys) || province;
                note = getValue(row, ['ข้อความจากผู้ซื้อ', 'หมายเหตุ'], rowKeys) || note;
                bookImageUrl = getValue(row, ['book_image_url', 'รูปภาพ', 'รูปใบ Book', 'Image', 'Photo', 'URL'], rowKeys);
                courierPhone = getValue(row, ['courier_phone', 'เบอร์ขนส่ง', 'เบอร์โทรขนส่ง', 'Courier Phone'], rowKeys);
                latestLocation = getValue(row, ['latest_location', 'สถานที่ล่าสุด', 'สาขาล่าสุด', 'Location'], rowKeys);
                trackingNumber = getValue(row, [
                    '*หมายเลขติดตามพัสดุ',
                    'หมายเลขติดตามพัสดุ', 
                    'เลขพัสดุ', 
                    'Tracking Number', 
                    'Tracking ID', 
                    'Tracking Number*', 
                    'Tracking No.',
                    'หมายเลขพัสดุ',
                    'tracking_number'
                ], rowKeys);
            } else if (platform === 'TikTok') {
                const dateRaw = getValue(row, ['Created Time'], rowKeys);
                if (dateRaw) { try { date = new Date(dateRaw.split(' ')[0].replace(/\//g,'-')).toISOString().split('T')[0]; } catch(e){} }
                orderNumber = getValue(row, ['Order ID'], rowKeys) || orderNumber;
                productCode = getValue(row, ['Seller SKU', 'SKU ID', 'sku'], rowKeys) || productCode;
                productName = getValue(row, ['Product Name', 'ชื่อสินค้า'], rowKeys) || productName;
                quantity = parseInt(getValue(row, ['Quantity'], rowKeys) || 1);
                price = parseFloat(getValue(row, ['1 SKU original price'], rowKeys) || 0);
                shipping = parseFloat(getValue(row, ['Shipping Fee', 'shipping fee'], rowKeys) || 0);
                buyer = getValue(row, ['Buyer Username', 'Recipient Name'], rowKeys) || buyer;
                address = getValue(row, ['Full Address', 'Detailed Address'], rowKeys);
                province = getValue(row, ['Province'], rowKeys) || province;
                note = getValue(row, ['Buyer Message', 'หมายเหตุ'], rowKeys) || note;
                bookImageUrl = getValue(row, ['book_image_url', 'รูปภาพ', 'รูปใบ Book', 'Image', 'Photo', 'URL'], rowKeys);
                courierPhone = getValue(row, ['courier_phone', 'เบอร์ขนส่ง', 'เบอร์โทรขนส่ง', 'Courier Phone'], rowKeys);
                latestLocation = getValue(row, ['latest_location', 'สถานที่ล่าสุด', 'สาขาล่าสุด', 'Location'], rowKeys);
                trackingNumber = getValue(row, ['Tracking Number', 'Tracking ID', 'tracking_number'], rowKeys);
            }
            
            // พยายามดึง SKU จากชื่อสินค้าในกรณีที่ได้มาไม่ครบ
            productCode = productCode || extractSkuFromName(productName);

            let { size, slots } = extractSizeAndSlots(productName);
            let pattern = null;
            let finalPrice = price; // ใช้ราคาจาก Excel เป็นพื้นฐาน
            
            // 2. ถ้าเจอใน masterDict เอาข้อมูลมาทับของเดิม (Overide Excel)
            const masterKeyCode = productCode ? 'CODE_' + productCode.toLowerCase().trim() : null;
            const masterKeyName = productName ? 'NAME_' + productName.toLowerCase().trim() : null;
            const master = masterDict[masterKeyCode] || masterDict[masterKeyName];
                           
            if (master) {
                matchCount++;
                if (master.product_code) productCode = master.product_code; 
                
                // ชื่อสินค้า (รองรับเฉพาะ name ตาม schema ปัจจุบัน)
                const masterName = master.name;
                if (masterName) productName = masterName;
                if (master.size) size = master.size;
                
                // ลาย (รองรับเฉพาะ pattern ตาม schema ปัจจุบัน)
                const masterPattern = master.pattern;
                if (masterPattern) pattern = masterPattern;
                if (master.slots != null) slots = parseInt(master.slots);
                if (master.price != null && master.price > 0) finalPrice = parseFloat(master.price);
            }

            // ดึงชื่อสีจาก JOIN (frame_color.color_name / glass_color.color_name) หรือ fallback เป็น code
            const glassFromRow = getValue(row, ['glass_color', 'glassColor', 'สีกระจก'], rowKeys);
            const screenFromRow = getValue(row, ['screen_type', 'screenType', 'มุ้ง', 'screen'], rowKeys);

            let aluminumColor = master ? (master.frame_color?.color_name || master.aluminum_color || master.frame_color_code || null) : null;
            let glassColor = master ? (master.glass_color?.color_name || master.glass_color || null) : glassFromRow;
            const glassCode = master?.glass_color_code;
            const frameColorCode = master?.frame_color_code;

            if (master) {
                if (!aluminumColor && frameColorCode) {
                    aluminumColor = await resolveColorName(frameColorCode, 'aluminum') || frameColorCode;
                }
                if (!glassColor && glassCode) {
                    glassColor = await resolveColorName(glassCode, 'glass') || glassCode;
                }
            }

            // ดึงสถานะมุ้ง: ลำดับความสำคัญ master.screen_type >Joined net_status >master.net_id > ค่าในไฟล์
            const masterNetStatus = master ? await resolveMosquitoNetStatus(master.net_id) : null;
            const screenType = master ? (
                master.screen_type || 
                masterNetStatus || 
                normalizeScreenType(master.net_id) || 
                screenFromRow
            ) : screenFromRow;
            // ถ้าไม่เข้า if (master) ข้างบน ค่า productCode จะยังคงเป็นค่าเดิมที่ดึงมาจากไฟล์ (sellerSku)

            parsedDataToUpload.push({
                order_date: date, platform: platform, order_number: orderNumber, product_code: productCode, product_name: productName,
                product_size: size, slots: slots, quantity: quantity, price: finalPrice, shipping_fee: shipping,
                buyer_name: buyer, address: address, province: province, 
                tracking_status: status, 
                book_image_url: bookImageUrl,
                note: note,
                tracking_number: trackingNumber, 
                courier_phone: courierPhone,
                latest_location: latestLocation,
                pattern: pattern,
                aluminum_color: aluminumColor,
                glass_color: normalizeGlassColor(glassColor),
                screen_type: normalizeScreenType(screenType)
            });

            // พักให้ UI ทำงานทุกๆ 200 แถว
            if (i % 200 === 0 && i > 0) {
                log(`ประมวลผลแล้ว ${i} แถว...`);
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
        
        if (matchCount > 0) {
            log(`🎯 แมตช์ข้อมูลกับ SKU Master สำเร็จทั้งหมด ${matchCount} รายการ`, 'success');
        }
        renderPreview();
    }

    function renderPreview() {
        const tbody = document.getElementById('previewBody');
        if (!tbody) return;
        tbody.innerHTML = '';
        document.getElementById('previewCount').textContent = parsedDataToUpload.length;
        document.getElementById('previewSection').style.display = 'block';
        parsedDataToUpload.slice(0, 10).forEach(item => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${item.platform}</td>
                <td>${item.order_date}</td>
                <td>${item.order_number}</td>
                <td>${item.tracking_number || '-'}</td>
                <td title="${item.product_code || ''}">${item.product_code || '-'}</td>
                <td title="${item.product_name}">${String(item.product_name).substring(0, 20)}..</td>
                <td>${item.product_size || '-'}</td>
                <td>${item.slots || '-'}</td>
                <td>${item.pattern || '-'}</td>
                <td>${item.aluminum_color || '-'}</td>
                <td>${item.glass_color || '-'}</td>
                <td>${item.screen_type || '-'}</td>
                <td>x${item.quantity} | ${item.price}฿</td>
                <td>${item.note || '-'}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    const bulkUploadBtn = document.getElementById('bulkUploadBtn');
    if (bulkUploadBtn) {
        bulkUploadBtn.addEventListener('click', async () => {
            if (!parsedDataToUpload.length || !dbSupabase) return;
            log(`กำลังเตรียมตรวจสอบข้อมูลซ้ำและอัปโหลด ${parsedDataToUpload.length} รายการ...`);
            
            const btnText = bulkUploadBtn.querySelector('.btn-text');
            const btnLoader = bulkUploadBtn.querySelector('.btn-loader');
            
            bulkUploadBtn.disabled = true;
            if (btnText) btnText.style.display = 'none';
            if (btnLoader) btnLoader.style.display = 'inline';
            
            try {
                // 1. ตรวจสอบข้อมูลที่มีอยู่แล้วตามเลขออเดอร์ และเลขพัสดุ
                const orderNumbers = parsedDataToUpload.map(o => o.order_number).filter(t => t);
                const trackingNumbers = parsedDataToUpload.map(o => o.tracking_number).filter(t => t);
                
                log(`กำลังค้นหาข้อมูลที่มีอยู่แล้วในระบบเพื่อจับคู่...`);
                let existingOrders = [];
                
                if (orderNumbers.length > 0) {
                    const uniqueOrderNums = [...new Set(orderNumbers)];
                    const checkChunkSize = 80;
                    
                    for (let i = 0; i < uniqueOrderNums.length; i += checkChunkSize) {
                        const chunk = uniqueOrderNums.slice(i, i + checkChunkSize);
                        const { data: existing, error: checkError } = await dbSupabase
                            .from(SUPABASE_TABLE_NAME)
                            .select('id, tracking_number, order_number, product_code')
                            .in('order_number', chunk);
                        if (checkError) throw checkError;
                        if (existing) existingOrders = existingOrders.concat(existing);
                    }
                }

                let itemsToInsert = [];
                let itemsToUpdate = [];
                const seenInFile = new Set();
                let skippedDbDup = 0;
                let skippedFileDup = 0;
                let availableDbOrders = [...existingOrders];

                parsedDataToUpload.forEach(item => {
                    const t = (item.tracking_number && String(item.tracking_number).trim() !== '-') ? String(item.tracking_number).trim() : null;
                    const fileKey = [item.order_number, item.platform, item.product_code, t].filter(Boolean).join('|');
                    
                    if (seenInFile.has(fileKey)) {
                        skippedFileDup++;
                        return;
                    }
                    seenInFile.add(fileKey);

                    // Logic: Tracking Number is the unique identifier for a shipment.
                    // Order Number and SKU can repeat.

                    if (t) {
                        // 1. Exact tracking match in DB => SKIP
                        const exactTrackingMatch = availableDbOrders.find(e => e.tracking_number === t);
                        if (exactTrackingMatch) {
                            skippedDbDup++;
                            return;
                        }

                        // 2. No exact tracking, but maybe we can update an existing order that is missing tracking?
                        // Match by (Order + SKU) where Tracking is currently missing in DB.
                        const potentialUpdate = availableDbOrders.find(e => 
                            e.order_number === item.order_number && 
                            e.product_code === item.product_code &&
                            (!e.tracking_number || e.tracking_number === '-' || e.tracking_number === '')
                        );

                        if (potentialUpdate) {
                            itemsToUpdate.push({
                                id: potentialUpdate.id,
                                tracking_number: t,
                                courier_phone: item.courier_phone,
                                latest_location: item.latest_location
                            });
                            // Remove from available to avoid multiple updates to same row
                            const globalIndex = availableDbOrders.findIndex(e => e.id === potentialUpdate.id);
                            if (globalIndex !== -1) availableDbOrders.splice(globalIndex, 1);
                            return;
                        }
                    }

                    // 3. For any other case (including no tracking or no match), always INSERT as a new row.
                    // This allows "Order Number can repeat" as per user request.
                    itemsToInsert.push({...item, tracking_number: t});
                });

                const skipCount = skippedDbDup + skippedFileDup;

                if (itemsToInsert.length === 0 && itemsToUpdate.length === 0) {
                    log("ข้อมูลซ้ำทั้งหมด! ไม่มีการบันทึก", "error");
                    alert(`⚠️ ข้อมูลในไฟล์นี้ถูกจับคู่ซ้ำกับในระบบทั้งหมดจำนวน ${skipCount} รายการ! ไม่มีการบันทึกใหม่`);
                    resetBulkUI();
                    return;
                }

                log(`เตรียมการ: อัปเดตข้อมูลเก่า ${itemsToUpdate.length} รายการ, บันทึกใหม่ ${itemsToInsert.length} รายการ (ข้ามรายการซ้ำ ${skipCount} รายการ)...`);

                // 1. ทำการอัปเดต
                let updatedCount = 0;
                for (const updateObj of itemsToUpdate) {
                    const { error } = await dbSupabase
                        .from(SUPABASE_TABLE_NAME)
                        .update({
                            tracking_number: updateObj.tracking_number,
                            courier_phone: updateObj.courier_phone,
                            latest_location: updateObj.latest_location
                        })
                        .eq('id', updateObj.id);
                    if (error) throw error;
                    updatedCount++;
                    if (updatedCount % 20 === 0) log(`อัปเดตข้อมูลแล้ว ${updatedCount}/${itemsToUpdate.length} รายการ`);
                }

                // 2. ทำการเพิ่มข้อมูลใหม่
                const chunkSize = 50;
                let insertedCount = 0;
                for (let i = 0; i < itemsToInsert.length; i += chunkSize) {
                    const chunk = itemsToInsert.slice(i, i + chunkSize);
                    const { error } = await dbSupabase.from(SUPABASE_TABLE_NAME).insert(chunk);
                    if (error) throw error;
                    insertedCount += chunk.length;
                    log(`บันทึกข้อมูลใหม่แล้ว ${insertedCount}/${itemsToInsert.length} รายการ`);
                }

                log("บันทึกข้อมูลและอัปเดตทั้งหมดสำเร็จ!", "success");
                alert(`✅ ดำเนินการสำเร็จ!\n- อัปเดตเลขพัสดุในออเดอร์เดิม: ${updatedCount} รายการ\n- บันทึกใหม่: ${insertedCount} รายการ\n- ข้ามรายการซ้ำ: ${skipCount} รายการ`);
                resetBulkUI();

            } catch (error) {
                log(`ล้มเหลว: ${error.message}`, "error");
                alert(`❌ เกิดข้อผิดพลาด: ${error.message}`);
            } finally {
                bulkUploadBtn.disabled = false;
                if (btnText) btnText.style.display = 'inline';
                if (btnLoader) btnLoader.style.display = 'none';
            }
        });

        function resetBulkUI() {
            parsedDataToUpload = [];
            if (fileInput) fileInput.value = ""; 
            const tbody = document.getElementById('previewBody');
            if (tbody) tbody.innerHTML = ""; 
            const ps = document.getElementById('previewSection');
            if (ps) ps.style.display = 'none';
            const fnd = document.getElementById('fileNameDisplay');
            if (fnd) fnd.textContent = "📂 ลากไฟล์มาวาง หรือ คลิกเพื่อเลือกไฟล์";
            log("รีเซ็ตระบบอัปโหลดเรียบร้อย พร้อมสำหรับไฟล์ใหม่");
        }
    }
});
