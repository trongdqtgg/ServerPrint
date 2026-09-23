const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { exec } = require('child_process');
const { print } = require('pdf-to-printer');
const sudoPrompt = require('sudo-prompt');
const { autoUpdater } = require('electron-updater');

// ================= TÊN CỐ ĐỊNH CHO MÁY IN ẢO / CỔNG ẢO =================
// Đặt tên cố định (không phụ thuộc IP) để không cần liệt kê/parse danh sách
// máy in - mỗi lần cài đặt chỉ cần xoá đúng tên cũ rồi tạo lại là đủ.
const VIRTUAL_PRINTER_NAME = 'LAN_Virtual_Printer';
const VIRTUAL_PORT_NAME = 'LAN_Virtual_Printer_Port';
const TCP_PRINT_PORT = 9100;
const FIREWALL_RULE_NAME = 'LAN Print TCP 9100';

let mainWindow;
let tcpPrinterServer = null;
let elevationRequested = false;
let autoUpdaterInitialized = false;

// KHÔNG được dùng __dirname để ghi file: khi đóng gói bằng electron-builder,
// __dirname trỏ vào bên trong "resources\app.asar" - đây là 1 FILE lưu trữ chỉ
// đọc chứ không phải thư mục thật, nên fs.mkdirSync/writeFileSync vào đó sẽ
// văng lỗi "ENOTDIR: not a directory" ngay khi khởi động trên máy người dùng.
// Dùng thư mục dữ liệu riêng của ứng dụng (%APPDATA%\LAN Print\...) - luôn
// ghi được, không phụ thuộc thư mục cài đặt (kể cả Program Files).
let VIRTUAL_PRINT_DIR = null;
function getVirtualPrintDir() {
    if (!VIRTUAL_PRINT_DIR) {
        VIRTUAL_PRINT_DIR = path.join(app.getPath('userData'), 'virtual-print-output');
    }
    fs.mkdirSync(VIRTUAL_PRINT_DIR, { recursive: true });
    return VIRTUAL_PRINT_DIR;
}

// ================= HÀM CHẠY LỆNH CMD (KHÔNG DÙNG POWERSHELL) =================
// Luôn resolve (không bao giờ reject) để logic gọi tiếp có thể tự quyết định
// bỏ qua lỗi (vd: xoá máy in/cổng cũ chưa tồn tại) hay dừng hẳn.
function runCmd(command, { timeout = 30000 } = {}) {
    return new Promise((resolve) => {
        exec(command, { windowsHide: true, timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({
                ok: !error,
                code: error ? error.code : 0,
                stdout: (stdout || '').toString().trim(),
                stderr: (stderr || '').toString().trim()
            });
        });
    });
}

// Kiểm tra app có đang chạy quyền Administrator hay không - "net session"
// chỉ chạy thành công khi có quyền admin, hoạt động thuần cmd.exe, không cần PowerShell.
async function isRunningAsAdmin() {
    const res = await runCmd('net session', { timeout: 8000 });
    return res.ok;
}

// Nếu ứng dụng chưa có quyền quản trị, tự mở lại chính nó bằng Windows UAC.
// sudo-prompt dùng helper native trên Windows nên không phụ thuộc PowerShell.
async function relaunchAsAdministrator() {
    if (process.platform !== 'win32') return true;
    if (await isRunningAsAdmin()) return true;
    if (elevationRequested) return false;

    elevationRequested = true;

    const quoteArg = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
    const args = app.isPackaged ? [] : [app.getAppPath()];
    const command = [quoteArg(process.execPath), ...args.map(quoteArg)].join(' ');

    sudoPrompt.exec(command, {
        name: 'LAN Print'
    }, (error) => {
        // Callback có thể được gọi khi người dùng từ chối UAC hoặc khi tiến
        // trình quyền Admin kết thúc. Chỉ ghi lỗi nếu cửa sổ hiện tại còn sống.
        if (error && !app.isQuitting) {
            elevationRequested = false;
            sendLog('⚠️ Bạn đã từ chối hoặc Windows không cấp quyền Administrator. Hãy mở lại ứng dụng và chọn Yes trong hộp thoại UAC.');
        }
    });

    // Cho helper đủ thời gian gọi UAC, sau đó đóng tiến trình không có quyền.
    setTimeout(() => {
        app.isQuitting = true;
        app.quit();
    }, 1200);

    return false;
}

// Dò thư mục chứa prnport.vbs / prnmngr.vbs (Printing_Admin_Scripts).
// Tên thư mục con phụ thuộc ngôn ngữ hệ điều hành (en-US, vi-VN, ...) nên
// phải tự dò thay vì hard-code. Đồng thời xử lý trường hợp app 32-bit chạy
// trên Windows 64-bit bị Windows File System Redirector chuyển hướng
// System32 -> SysWOW64 (nơi KHÔNG có thư mục này) bằng cách thử thêm
// đường dẫn "Sysnative".
function findPrintingAdminScriptsDir() {
    const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
    const candidates = [
        path.join(windir, 'Sysnative', 'Printing_Admin_Scripts'),
        path.join(windir, 'System32', 'Printing_Admin_Scripts')
    ];

    for (const base of candidates) {
        if (!fs.existsSync(base)) continue;
        let entries = [];
        try {
            entries = fs.readdirSync(base, { withFileTypes: true });
        } catch (e) {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(base, entry.name);
            if (fs.existsSync(path.join(dir, 'prnport.vbs')) && fs.existsSync(path.join(dir, 'prnmngr.vbs'))) {
                return dir;
            }
        }
    }
    return null;
}

// Chuẩn hoá tên hive để so khớp: "reg query" luôn CHẤP NHẬN cả "HKLM" lẫn
// "HKEY_LOCAL_MACHINE" khi truyền vào, nhưng khi IN KẾT QUẢ ra thì luôn dùng
// dạng đầy đủ "HKEY_LOCAL_MACHINE". Cần quy về cùng 1 dạng để so sánh chính xác.
function normalizeRegKeyPath(keyPath) {
    return keyPath
        .replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\')
        .trim()
        .toUpperCase();
}

// Trích danh sách tên (sub-key cuối cùng) từ output của "reg query <key>".
// LƯU Ý QUAN TRỌNG: reg.exe luôn in ra CHÍNH cái key vừa truy vấn ở dòng đầu
// tiên (trước khi liệt kê các sub-key con) - dòng đó PHẢI được loại bỏ, nếu
// không sẽ bị nhầm phần cuối của chính key đang truy vấn (vd "Version-4")
// thành 1 "sub-key"/driver, gây lỗi chọn nhầm driver không tồn tại.
function parseRegSubKeyNames(stdout, queriedKey) {
    if (!stdout) return [];
    const selfKeyNormalized = queriedKey ? normalizeRegKeyPath(queriedKey) : null;

    return stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.toUpperCase().startsWith('HKEY_LOCAL_MACHINE'))
        .filter(line => !selfKeyNormalized || line.toUpperCase() !== selfKeyNormalized)
        .map(line => {
            const idx = line.lastIndexOf('\\');
            return idx >= 0 ? line.substring(idx + 1).trim() : '';
        })
        .filter(Boolean);
}

// Kiểm tra 1 registry key có tồn tại hay không (dùng để XÁC MINH LẠI kết quả
// thật sự sau khi chạy cscript, vì nhiều script .vbs quản trị máy in cũ của
// Windows luôn thoát với exit code 0 dù bên trong bị lỗi logic (vd tên
// driver/port sai) - không thể chỉ tin vào exit code của cscript).
async function regKeyExists(keyPath) {
    const res = await runCmd(`reg query "${keyPath}"`);
    return res.ok;
}

// Đọc 1 giá trị REG_SZ cụ thể trong 1 key, dùng để xác minh nội dung thật sự
// (vd IP của cổng) chứ không chỉ xác minh key có tồn tại hay không.
async function readRegValue(keyPath, valueName) {
    const res = await runCmd(`reg query "${keyPath}" /v ${valueName}`);
    if (!res.ok) return null;
    // Dòng chứa giá trị có dạng: "    HostName    REG_SZ    192.168.1.100"
    const line = res.stdout.split(/\r?\n/).find(l => l.trim().startsWith(valueName));
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    return parts.length >= 3 ? parts.slice(2).join(' ') : null;
}

// Liệt kê tất cả máy in đã cài trên máy có TÊN BẮT ĐẦU BẰNG 1 tiền tố cho
// trước (dùng để tìm các bản sao "LAN_Virtual_Printer (Copy 1)", "(Copy 2)"
// ... mà Windows tự sinh ra khi trùng tên).
async function listPrintersWithPrefix(prefix) {
    const printersKey = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers';
    const res = await runCmd(`reg query "${printersKey}"`);
    if (!res.ok) return [];
    return parseRegSubKeyNames(res.stdout, printersKey)
        .filter(name => name.toLowerCase().startsWith(prefix.toLowerCase()));
}

// Xoá 1 máy in theo tên và XÁC MINH LẠI bằng registry (không tin exit code
// của cscript) - trả về true nếu chắc chắn đã xoá xong.
async function deletePrinterVerified(prnmngrVbs, printerName) {
    await runCmd(`cscript //nologo "${prnmngrVbs}" -d -p "${printerName}"`);
    const key = `HKLM\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers\\${printerName}`;
    const stillExists = await regKeyExists(key);
    return !stillExists;
}

// Tìm 1 driver máy in đã cài sẵn trên máy, đọc thẳng từ Registry bằng
// "reg query" (không cần PowerShell/WMI). Ưu tiên driver "thật" (không
// phải OneNote/PDF/XPS/Fax), nếu không có thì lấy driver đầu tiên tìm được.
async function findInstalledPrinterDriver() {
    const envKeyRoot = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Print\\Environments';
    const envListRes = await runCmd(`reg query "${envKeyRoot}"`);
    let environments = parseRegSubKeyNames(envListRes.stdout, envKeyRoot);
    if (environments.length === 0) {
        // Fallback: hầu hết máy Windows hiện đại dùng key "Windows x64"
        environments = ['Windows x64', 'Windows NT x86'];
    }

    const allDrivers = [];
    for (const env of environments) {
        for (const version of ['Version-3', 'Version-4']) {
            const driverKey = `${envKeyRoot}\\${env}\\Drivers\\${version}`;
            const res = await runCmd(`reg query "${driverKey}"`);
            if (!res.ok) continue; // key không tồn tại -> bỏ qua, không phải lỗi
            for (const name of parseRegSubKeyNames(res.stdout, driverKey)) {
                // Lá chắn phòng hờ thêm: loại bỏ mọi tên trùng với các "đoạn
                // đường dẫn kỹ thuật" (không phải tên driver thật) phòng khi
                // vẫn còn lọt lưới vì lý do khác.
                if (/^(Version-3|Version-4|Drivers|Environments)$/i.test(name)) continue;
                if (!allDrivers.includes(name)) allDrivers.push(name);
            }
        }
    }

    if (allDrivers.length === 0) return null;

    const preferred = allDrivers.find(name => !/OneNote|PDF|XPS|Fax/i.test(name));
    return preferred || allDrivers[0];
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 700,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.loadFile('index.html');
}

// Lấy toàn bộ IPv4 LAN đang hoạt động để máy Client biết IP cần kết nối.
function getLocalIPv4Addresses() {
    const addresses = [];
    const interfaces = os.networkInterfaces();

    for (const [interfaceName, items] of Object.entries(interfaces)) {
        for (const item of items || []) {
            if (item.family !== 'IPv4' || item.internal) continue;
            addresses.push({ interfaceName, address: item.address });
        }
    }

    return addresses;
}

// Mở cổng 9100 trên Windows Firewall. Xoá rule cùng tên trước để luôn đồng bộ
// đúng cấu hình mới nhất, không tạo nhiều rule trùng nhau.
async function openPrintPortInFirewall() {
    if (process.platform !== 'win32') return true;

    await runCmd(`netsh advfirewall firewall delete rule name="${FIREWALL_RULE_NAME}"`);
    const addRule = await runCmd(
        `netsh advfirewall firewall add rule name="${FIREWALL_RULE_NAME}" dir=in action=allow protocol=TCP localport=${TCP_PRINT_PORT} profile=any enable=yes`
    );

    if (!addRule.ok) {
        sendLog(`⚠️ Không mở được cổng ${TCP_PRINT_PORT} trên Windows Firewall: ${addRule.stderr || addRule.stdout}`);
        return false;
    }

    sendLog(`✅ Đã mở cổng TCP ${TCP_PRINT_PORT} trên Windows Firewall.`);
    return true;
}

// Tìm PID đang sử dụng cổng in. Chỉ lấy PID dạng số từ netstat, không đưa
// dữ liệu bên ngoài vào lệnh taskkill.
async function findPidsUsingPrintPort() {
    if (process.platform !== 'win32') return [];
    const result = await runCmd('netstat -ano -p tcp');
    if (!result.ok) return [];

    const pids = new Set();
    for (const line of result.stdout.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4 || parts[0].toUpperCase() !== 'TCP') continue;
        if (!parts[1].endsWith(`:${TCP_PRINT_PORT}`)) continue;
        const pid = Number(parts[parts.length - 1]);
        if (Number.isInteger(pid) && pid > 4 && pid !== process.pid) pids.add(pid);
    }
    return [...pids];
}

async function releasePrintPort() {
    const pids = await findPidsUsingPrintPort();
    if (pids.length === 0) {
        sendLog(`Cổng ${TCP_PRINT_PORT} không bị tiến trình khác chiếm.`);
        return true;
    }

    sendLog(`Phát hiện cổng ${TCP_PRINT_PORT} đang bị chiếm bởi PID: ${pids.join(', ')}. Đang giải phóng...`);
    let allReleased = true;
    for (const pid of pids) {
        const killed = await runCmd(`taskkill /PID ${pid} /F`);
        if (!killed.ok) {
            allReleased = false;
            sendLog(`❌ Không thể đóng PID ${pid}: ${killed.stderr || killed.stdout}`);
        } else {
            sendLog(`Đã đóng PID ${pid} đang giữ cổng ${TCP_PRINT_PORT}.`);
        }
    }

    await new Promise(resolve => setTimeout(resolve, 600));
    return allReleased;
}

// ================= TCP SOCKET SERVER NHẬN DỮ LIỆU IN RAW TỪ WINDOWS =================
function listenVirtualPrinterServer() {
    return new Promise((resolve) => {
        if (tcpPrinterServer) {
            resolve(true);
            return;
        }

        const server = net.createServer((socket) => {
        sendLog(`Nhận kết nối in từ máy: ${socket.remoteAddress}`);

        let fileChunks = [];

        socket.on('data', (chunk) => {
            fileChunks.push(chunk);
        });

        socket.on('end', () => {
            const buffer = Buffer.concat(fileChunks);

            if (buffer.length > 0) {
                const timestamp = Date.now();
                const outputFileName = `print_job_${timestamp}.prn`;
                let outputPath;
                try {
                    outputPath = path.join(getVirtualPrintDir(), outputFileName);
                    fs.writeFileSync(outputPath, buffer);
                } catch (err) {
                    sendLog(`❌ Không lưu được file in: ${err.message}`);
                    return;
                }
                sendLog(`🔥 ĐÃ LƯU THÀNH CÔNG file in: ${outputFileName} (${buffer.length} bytes)`);

                print(outputPath)
                    .then(() => sendLog(`✅ Đã gửi file in ra máy in vật lý thành công!`))
                    .catch(err => sendLog(`⚠️ Lỗi in vật lý: ${err.message}`));
            }
        });

        socket.on('error', (err) => {
            sendLog(`Lỗi kết nối Socket: ${err.message}`);
        });
        });

        const onListenError = (err) => {
            if (tcpPrinterServer === server) tcpPrinterServer = null;
            resolve(err);
        };
        server.once('error', onListenError);

        server.listen(TCP_PRINT_PORT, '0.0.0.0', () => {
            server.removeListener('error', onListenError);
            tcpPrinterServer = server;
            server.on('error', err => sendLog(`Lỗi TCP Print Server: ${err.message}`));
            sendLog(`✅ TCP Print Server đang lắng nghe trên cổng ${TCP_PRINT_PORT}.`);
            resolve(true);
        });
    });
}

async function startVirtualPrinterServer({ forceRelease = false } = {}) {
    await openPrintPortInFirewall();

    if (forceRelease) {
        await stopVirtualPrinterServer(false);
        await releasePrintPort();
    }

    let result = await listenVirtualPrinterServer();
    if (result === true) return true;

    if (result && result.code === 'EADDRINUSE') {
        sendLog(`⚠️ Cổng ${TCP_PRINT_PORT} đang bị chiếm. Ứng dụng sẽ tự giải phóng và mở lại cổng...`);
        const released = await releasePrintPort();
        if (released) result = await listenVirtualPrinterServer();
    }

    if (result !== true) {
        sendLog(`❌ Không thể mở TCP Print Server trên cổng ${TCP_PRINT_PORT}: ${result.message || result}`);
        return false;
    }
    return true;
}

function stopVirtualPrinterServer(showLog = true) {
    if (!tcpPrinterServer) return Promise.resolve();
    const serverToClose = tcpPrinterServer;
    tcpPrinterServer = null;
    return new Promise(resolve => {
        serverToClose.close(() => {
            if (showLog) sendLog('Đã dừng chế độ Server.');
            resolve();
        });
    });
}

ipcMain.handle('get-local-ip-addresses', () => getLocalIPv4Addresses());

ipcMain.on('set-app-mode', async (event, mode) => {
    if (mode === 'server') {
        await startVirtualPrinterServer();
        const ips = getLocalIPv4Addresses();
        sendLog(ips.length
            ? `IP Server hiện tại: ${ips.map(item => item.address).join(', ')}`
            : '⚠️ Chưa tìm thấy địa chỉ IPv4 LAN. Hãy kiểm tra kết nối mạng.');
        return;
    }

    if (mode === 'client') {
        await stopVirtualPrinterServer();
        sendLog('Đã chọn chế độ Client. Nhập IP của máy Server để cài máy in ảo.');
    }
});

ipcMain.on('reclaim-print-port', async () => {
    sendLog(`Đang giải phóng, mở Firewall và chiếm lại cổng ${TCP_PRINT_PORT}...`);
    await startVirtualPrinterServer({ forceRelease: true });
});

// ================= TỰ ĐỘNG CẬP NHẬT IP, TẠO MÁY IN MỚI & ÉP SET DEFAULT CHUẨN XÁC =================
// KHÔNG dùng PowerShell (powershell.exe) ở đây nữa - nhiều máy chặn hẳn
// PowerShell (chính sách công ty / AntiVirus chặn "-EncodedCommand" vì đây
// là kiểu lệnh hay bị nhận diện là mã độc). Thay vào đó dùng toàn bộ công
// cụ có sẵn từ thời Windows XP/2000 và chạy qua cmd.exe:
//   - net stop/start spooler      : khởi động lại dịch vụ Spooler
//   - cscript prnport.vbs         : thêm/xoá cổng TCP/IP (RAW) chuẩn
//   - cscript prnmngr.vbs         : thêm/xoá máy in, đặt máy in mặc định
//   - reg query                   : dò driver máy in đã cài sẵn trong Registry
ipcMain.on('install-virtual-printer', async (event, serverIp) => {
    try {
        sendLog(`Đang cấu hình máy in ảo trỏ tới IP Server mới: ${serverIp} (Cổng 9100)...`);

        // 0. Kiểm tra quyền Administrator - toàn bộ thao tác bên dưới đều
        //    cần quyền admin (giống hệt yêu cầu của bản PowerShell cũ).
        const isAdmin = await isRunningAsAdmin();
        if (!isAdmin) {
            sendLog('⚠️ Ứng dụng chưa chạy với quyền Administrator. Vui lòng chuột phải file, chọn "Run as administrator" rồi thử lại.');
            return;
        }

        // 1. Xác định thư mục chứa prnport.vbs / prnmngr.vbs
        const scriptsDir = findPrintingAdminScriptsDir();
        if (!scriptsDir) {
            sendLog('❌ Không tìm thấy thư mục Printing_Admin_Scripts (prnport.vbs / prnmngr.vbs) trên máy này.');
            sendLog('   Máy này có thể đã bị gỡ bỏ thành phần quản trị in ấn của Windows. Vui lòng cài đặt máy in ảo thủ công qua "Devices and Printers".');
            return;
        }
        const prnportVbs = path.join(scriptsDir, 'prnport.vbs');
        const prnmngrVbs = path.join(scriptsDir, 'prnmngr.vbs');

        // 2. Khởi động lại Spooler để giải phóng tài nguyên kẹt (thuần cmd, không cần PowerShell)
        await runCmd('net stop spooler');
        await runCmd('net start spooler');
        sendLog('Đã khởi động lại dịch vụ Print Spooler.');

        // 3. DỌN DẸP MÁY IN TRÙNG/THỪA: khi tên "LAN_Virtual_Printer" bị
        // chiếm (xoá không thành công ở 1 lần chạy trước, hoặc bất kỳ lý do
        // gì), Windows KHÔNG báo lỗi mà tự đổi tên máy in mới thành
        // "LAN_Virtual_Printer (Copy 1)", "(Copy 2)"... -> phải quét & xoá
        // sạch mọi bản sao này trước, chỉ giữ lại (nếu có) đúng 1 máy in tên
        // gốc. Nhờ vậy không bao giờ còn bị "spam" tạo máy in mới nữa.
        const existingNames = await listPrintersWithPrefix(VIRTUAL_PRINTER_NAME);
        const staleDuplicates = existingNames.filter(name => name !== VIRTUAL_PRINTER_NAME);
        for (const dupName of staleDuplicates) {
            const deleted = await deletePrinterVerified(prnmngrVbs, dupName);
            sendLog(deleted
                ? `Đã xoá máy in trùng/thừa: ${dupName}`
                : `⚠️ Không xoá được máy in thừa "${dupName}" (có thể đang mở hộp thoại in / có tài liệu đang chờ in tới nó). Vui lòng đóng các cửa sổ liên quan rồi thử lại, hoặc xoá tay trong "Devices and Printers".`);
        }

        // Nếu máy in tên gốc VẪN đang tồn tại (từ lần cài trước), không xoá
        // đi tạo lại nữa (dễ gặp lại đúng lỗi xoá-âm-thầm-thất-bại ở trên) -
        // chỉ cần trỏ lại cổng của nó sang IP Server mới là đủ, xem bước 5.
        const printerKey = `HKLM\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers\\${VIRTUAL_PRINTER_NAME}`;
        const printerAlreadyExists = await regKeyExists(printerKey);

        // 4. Cổng RAW: nếu đã tồn tại (từ lần cài trước) thì CẤU HÌNH LẠI
        // (-t) để trỏ sang IP Server mới; nếu chưa có thì tạo mới (-a).
        // Cách này không bao giờ cần xoá cổng, tránh mọi rủi ro xoá thất bại.
        const portKey = `HKLM\\SYSTEM\\CurrentControlSet\\Control\\Print\\Monitors\\Standard TCP/IP Port\\Ports\\${VIRTUAL_PORT_NAME}`;
        const portAlreadyExists = await regKeyExists(portKey);

        if (portAlreadyExists) {
            await runCmd(`cscript //nologo "${prnportVbs}" -t -r "${VIRTUAL_PORT_NAME}" -h "${serverIp}" -o raw -n 9100`);
            const currentHost = await readRegValue(portKey, 'HostName');
            if (currentHost !== serverIp) {
                sendLog(`[LỖI CẬP NHẬT CỔNG]: Cổng "${VIRTUAL_PORT_NAME}" vẫn đang trỏ tới "${currentHost || '?'}" thay vì "${serverIp}" sau khi cấu hình lại.`);
                return;
            }
            sendLog(`Đã cập nhật cổng có sẵn "${VIRTUAL_PORT_NAME}" trỏ sang IP mới: ${serverIp}:9100`);
        } else {
            const addPort = await runCmd(`cscript //nologo "${prnportVbs}" -a -r "${VIRTUAL_PORT_NAME}" -h "${serverIp}" -o raw -n 9100`);
            // KHÔNG tin hẳn vào exit code của cscript (nhiều script .vbs cũ
            // của Windows vẫn thoát mã 0 dù bên trong lỗi) - xác minh lại
            // bằng cách kiểm tra thẳng registry xem cổng đã thực sự tạo chưa.
            const portCreated = await regKeyExists(portKey);
            if (!addPort.ok || !portCreated) {
                sendLog(`[LỖI TẠO CỔNG]: ${addPort.stderr || addPort.stdout || 'Không tạo được cổng TCP/IP (không thấy trong Registry sau khi tạo).'}`);
                return;
            }
            sendLog(`Đã tạo cổng RAW thành công trỏ tới: ${serverIp}:9100`);
        }

        // 5. Máy in: nếu tên gốc đã tồn tại thì GIỮ NGUYÊN (nó dùng chung
        // cổng ở trên nên tự động in sang IP mới, không cần đụng tới máy
        // in); nếu chưa có thì mới tạo mới.
        if (printerAlreadyExists) {
            const assignedPort = await readRegValue(printerKey, 'Port');
            if (assignedPort && assignedPort !== VIRTUAL_PORT_NAME) {
                sendLog(`⚠️ Máy in "${VIRTUAL_PRINTER_NAME}" đã tồn tại nhưng đang trỏ vào cổng khác ("${assignedPort}" thay vì "${VIRTUAL_PORT_NAME}"). Vui lòng kiểm tra lại thủ công trong "Devices and Printers" -> Properties -> Ports.`);
            }
            sendLog(`Máy in ảo "${VIRTUAL_PRINTER_NAME}" đã tồn tại sẵn, chỉ cập nhật lại IP của cổng (không tạo máy in mới).`);
        } else {
            // 5a. Dò 1 driver máy in đã cài sẵn trên hệ thống (đọc từ Registry)
            const driverName = await findInstalledPrinterDriver();
            if (!driverName) {
                sendLog('❌ Không tìm thấy bất kỳ Driver máy in nào trên hệ thống. Vui lòng cài đặt (hoặc thêm) ít nhất 1 driver máy in bất kỳ trước khi cài máy in ảo.');
                return;
            }
            sendLog(`Sử dụng Driver: ${driverName}`);

            // 5b. Tạo máy in mới trỏ vào cổng ở trên
            const addPrinter = await runCmd(`cscript //nologo "${prnmngrVbs}" -a -p "${VIRTUAL_PRINTER_NAME}" -m "${driverName}" -r "${VIRTUAL_PORT_NAME}"`);
            // Xác minh lại bằng registry - bằng chứng chắc chắn nhất rằng
            // Windows đã thực sự tạo máy in (thay vì chỉ tin cscript thoát mã 0).
            const printerCreated = await regKeyExists(printerKey);
            if (!addPrinter.ok || !printerCreated) {
                sendLog(`[LỖI TẠO MÁY IN]: ${addPrinter.stderr || addPrinter.stdout || `Không thấy máy in '${VIRTUAL_PRINTER_NAME}' trong Registry sau khi tạo - driver "${driverName}" có thể không hợp lệ.`}`);
                return;
            }
            sendLog(`Tạo máy in '${VIRTUAL_PRINTER_NAME}' thành công!`);
        }

        // 6. Đặt làm máy in mặc định - dùng rundll32 printui.dll,PrintUIEntry
        //    (/y /n <tên>) thay vì prnmngr.vbs -t, vì đây là API set-default
        //    chính chủ của Windows Print UI, đáng tin cậy hơn và có trên mọi
        //    bản Windows từ Windows 2000 tới nay, không cần PowerShell.
        const setDefault = await runCmd(`rundll32 printui.dll,PrintUIEntry /y /n "${VIRTUAL_PRINTER_NAME}"`);
        if (!setDefault.ok) {
            sendLog(`⚠️ Đã tạo máy in nhưng chưa đặt mặc định được: ${setDefault.stderr || setDefault.stdout}`);
            sendLog('   Vui lòng vào "Devices and Printers" đặt máy in này làm mặc định thủ công.');
            return;
        }
        sendLog('Đã đặt máy in mặc định thành công!');

        sendLog('🎉 Hoàn tất! Máy in ảo đã được cài đặt và thiết lập mặc định thành công (không cần PowerShell).');
    } catch (err) {
        sendLog(`[LỖI CÀI ĐẶT]: ${err.message}`);
    }
});

function sendLog(text) {
    console.log(text);
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('log-message', text);
    }
}

function sendUpdateStatus(status, text, percent = null) {
    sendLog(text);
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('update-status', { status, text, percent });
    }
}

function checkForApplicationUpdates(manual = false) {
    if (!app.isPackaged) {
        if (manual) sendUpdateStatus('development', 'Auto Update chỉ hoạt động trên bản .exe đã đóng gói.');
        return;
    }

    if (manual) sendUpdateStatus('checking', 'Đang kiểm tra phiên bản mới...');
    autoUpdater.checkForUpdates().catch(err => {
        sendUpdateStatus('error', `Không kiểm tra được cập nhật: ${err.message}`);
    });
}

function setupAutoUpdater() {
    if (autoUpdaterInitialized || !app.isPackaged) return;
    autoUpdaterInitialized = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
        sendUpdateStatus('checking', 'Đang kiểm tra phiên bản mới...');
    });
    autoUpdater.on('update-available', info => {
        sendUpdateStatus('downloading', `Có phiên bản mới v${info.version}. Đang tự động tải xuống...`, 0);
    });
    autoUpdater.on('update-not-available', () => {
        sendUpdateStatus('latest', `Bạn đang dùng phiên bản mới nhất v${app.getVersion()}.`);
    });
    autoUpdater.on('download-progress', progress => {
        const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
        sendUpdateStatus('downloading', `Đang tải bản cập nhật: ${percent}%`, percent);
    });
    autoUpdater.on('error', err => {
        sendUpdateStatus('error', `Lỗi Auto Update: ${err.message}`);
    });
    autoUpdater.on('update-downloaded', async info => {
        sendUpdateStatus('ready', `Đã tải xong phiên bản v${info.version}.`);
        const result = await dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'LAN Print - Cập nhật sẵn sàng',
            message: `Phiên bản v${info.version} đã tải xong.`,
            detail: 'Khởi động lại ứng dụng để cài đặt bản cập nhật ngay bây giờ?',
            buttons: ['Khởi động lại và cập nhật', 'Để sau'],
            defaultId: 0,
            cancelId: 1,
            noLink: true
        });
        if (result.response === 0) {
            app.isQuitting = true;
            autoUpdater.quitAndInstall(false, true);
        }
    });

    setTimeout(() => checkForApplicationUpdates(false), 3000);
}

ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.on('check-for-updates', () => checkForApplicationUpdates(true));

app.whenReady().then(() => {
    relaunchAsAdministrator().then((alreadyElevated) => {
        if (!alreadyElevated) return;
        createWindow();
        setupAutoUpdater();
    });
});

app.on('window-all-closed', () => {
    if (tcpPrinterServer) tcpPrinterServer.close();
    if (process.platform !== 'darwin') app.quit();
});
