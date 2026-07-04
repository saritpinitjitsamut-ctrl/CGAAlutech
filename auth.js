// Supabase Configuration — โหลดจาก config.js (ถูก gitignore แล้ว)
// ถ้าเปิดหน้าเว็บแล้วไม่ทำงาน ให้ตรวจสอบว่ามีไฟล์ config.js อยู่ในโฟลเดอร์
if (!window.SUPABASE_CONFIG) {
    document.addEventListener('DOMContentLoaded', () => {
        document.body.innerHTML = `
            <div style="font-family:'Kanit',sans-serif;text-align:center;padding:50px;color:white;background:#050811;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;">
                <h2 style="color:#f87171;">⚠️ ไม่พบไฟล์ config.js</h2>
                <p style="color:#94a3b8;margin:20px 0;">กรุณาสร้างไฟล์ <code style="background:#1e293b;padding:4px 8px;border-radius:6px;color:#fbbf24;">config.js</code> โดยคัดลอกจาก <code style="background:#1e293b;padding:4px 8px;border-radius:6px;color:#fbbf24;">config.example.js</code> แล้วใส่ค่า Supabase URL และ KEY ของคุณ</p>
                <p style="color:#64748b;font-size:0.85rem;">ดูวิธีติดตั้งใน README.md</p>
            </div>`;
    });
}

// Initialize Supabase
let supabaseClient = null;
if (window.supabase && window.SUPABASE_CONFIG) {
    supabaseClient = window.supabase.createClient(window.SUPABASE_CONFIG.URL, window.SUPABASE_CONFIG.KEY);
}

// Page Role Mapping
const PAGE_ROLES = {
    'index.html': ['Admin', 'Ceo'],

    'dashboard.html': ['Admin', 'Ceo'],

    'executive_dashboard.html': ['Ceo'],
    'production.html': ['pdtPerson', 'Ceo'],
    'production_history.html': ['Ceo'],
    'damage_report.html': ['Ceo'],
    'material_prep.html': ['Ceo', 'APRD'],
    'stock_management.html': ['Ceo', 'APRD', 'Admin'],
    'backup_stock.html': ['Ceo', 'APRD', 'Admin', 'pdtPerson']
};


async function checkAuth() {
    if (!supabaseClient) return;

    const { data: { session } } = await supabaseClient.auth.getSession();
    const pathParts = window.location.pathname.split('/');
    const currentPage = pathParts[pathParts.length - 1] || 'index.html';

    // If on login page, just check if already logged in
    if (currentPage === 'login.html') {
        if (session) {
            redirectBasedOnRole(session.user);
        }
        return;
    }

    // Not logged in -> Redirect to login
    if (!session) {
        window.location.href = 'login.html';
        return;
    }

    // Fetch user role
    const { data: profile, error } = await supabaseClient
        .from('profiles')
        .select('role')
        .eq('id', session.user.id)
        .single();

    if (error || !profile) {
        console.error("Auth Error:", error);
        // Error handling for missing profile
        document.body.innerHTML = `
            <div style="font-family:'Kanit', sans-serif; text-align:center; padding:50px; color:white; background:#050811; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center;">
                <h2 style="color:#f87171;">⚠️ ไม่พบข้อมูลสิทธิ์การใช้งาน</h2>
                <p style="color:#94a3b8; margin: 20px 0;">ID ของคุณคือ: <code style="background:#1e293b; padding:4px 8px; border-radius:6px; color:#fbbf24;">${session.user.id}</code></p>
                <p style="color:#94a3b8;">กรุณาคัดลอก ID ด้านบนไปเพิ่มในตาราง profiles และกำหนดสิทธิ์ (Admin, Ceo หรือ pdtPerson)</p>
                <button onclick="auth.logout()" style="margin-top:30px; padding:12px 24px; cursor:pointer; background:#1e293b; border:1px solid #334155; color:white; border-radius:12px; font-family:inherit;">
                    🚪 กลับไปหน้า Login
                </button>
            </div>`;
        return;
    }

    const userRole = profile.role;
    window.auth.role = userRole; // Expose role
        // Prevent Admin role from accessing certain pages
        try {
            const forbiddenForAdmin = ['stock_management.html'];
            const path = window.location.pathname || window.location.href;
            const currentPage = path.split('/').pop();
            if (userRole === 'Admin' && forbiddenForAdmin.includes(currentPage)) {
                // Redirect Admin away from this page and notify
                alert('สิทธิ์ไม่เพียงพอ: ผู้ใช้งานในกลุ่ม Admin ไม่สามารถเข้าหน้านี้ได้');
                // Prefer sending to dashboard or backup stock
                const fallback = 'backup_stock.html';
                window.location.replace(fallback);
            }
        } catch (e) { console.warn('RBAC redirect check failed', e); }
    const allowedRoles = PAGE_ROLES[currentPage];


    // Initialize UI with user info and filters
    initUI(session.user, userRole);

    if (allowedRoles && !allowedRoles.includes(userRole)) {
        alert("ขออภัย คุณไม่มีสิทธิ์เข้าถึงหน้านี้ (สิทธิ์ของคุณคือ: " + userRole + ")");
        redirectBasedOnRole(session.user, userRole);
    }
}

function initUI(user, role) {
    // 1. Update User Display Area
    const displayArea = document.getElementById('user-display-area');
    if (displayArea) {
        const roleColors = {
            'Admin': '#818cf8',
            'Ceo': '#34d399',
            'pdtPerson': '#fbbf24',
            'APRD': '#a855f7'
        };

        const color = roleColors[role] || '#94a3b8';
        
        displayArea.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.03); padding: 5px 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.05); font-size: 0.85rem;">
                <span style="color: #94a3b8;">👤</span>
                <span style="color: #e2e8f0; font-weight: 400; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${user.email}">${user.email}</span>
                <span style="width: 1px; height: 12px; background: rgba(255,255,255,0.1); margin: 0 4px;"></span>
                <span style="color: ${color}; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em;">${role}</span>
            </div>
        `;
    }

    // 2. Role-based Visibility Filtering
    const elements = document.querySelectorAll('[data-allowed-roles]');
    elements.forEach(el => {
        const allowedStr = el.getAttribute('data-allowed-roles');
        if (allowedStr) {
            const allowed = allowedStr.split(',').map(r => r.trim());
            if (!allowed.includes(role)) {
                el.style.display = 'none';
            } else {
                // Ensure it's visible if it was hidden before (e.g. state change)
                if (el.style.display === 'none') el.style.display = '';
            }
        }
    });

    console.log(`UI Initialized for ${user.email} as ${role}`);
}

function redirectBasedOnRole(user, role = null) {
    if (role) {
        if (role === 'pdtPerson') window.location.href = 'production.html';
        else if (role === 'Admin') window.location.href = 'index.html';
        else if (role === 'Ceo') window.location.href = 'index.html';
        else if (role === 'APRD') window.location.href = 'material_prep.html';

        return;

    }

    // Fetch role if not provided
    supabaseClient.from('profiles').select('role').eq('id', user.id).single().then(({ data }) => {
        if (data) redirectBasedOnRole(user, data.role);
        else {
            // No profile found during redirection, show the error state or redirect to login
            window.location.reload(); 
        }
    });
}

async function logout() {
    if (supabaseClient) {
        await supabaseClient.auth.signOut();
        window.location.href = 'login.html';
    }
}

// Run auth check on load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAuth);
} else {
    checkAuth();
}

// Export for use in pages
window.auth = {
    supabase: supabaseClient,
    logout: logout,
    role: null // Will be set after checkAuth
};


