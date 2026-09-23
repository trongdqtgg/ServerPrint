// Tự publish bản build lên GitHub Releases (thay cho "electron-builder --publish").
//
// Vì sao không để electron-builder tự publish? Nó hay lỗi 422 khi:
//   - "Published releases must have a valid tag" : repo trống / chưa có tag
//   - "already_exists tag_name"                  : đã có release (thường là bản
//      nháp sót lại từ lần build lỗi trước) mà electron-builder không nhận ra
// Script này xử lý hết: tạo commit đầu tiên nếu repo trống, tạo tag, DÙNG LẠI
// release đã có (draft hoặc chưa có file) thay vì tạo trùng, thay file cũ
// cùng tên, rồi mới publish.
//
// Cách dùng:
//   node scripts/publish-github.js --check   : chỉ kiểm tra repo/token/version (chạy trước khi build)
//   node scripts/publish-github.js           : upload file trong thư mục dist và publish release
//
// Cần Node.js 18+ và biến môi trường GH_TOKEN.

const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');

const CHECK_ONLY = process.argv.includes('--check');
const ROOT = path.join(__dirname, '..');
const publish = pkg.build && pkg.build.publish && pkg.build.publish[0];
const owner = publish && publish.owner;
const repo = publish && publish.repo;
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const version = pkg.version;
const tag = `v${version}`;
const outDir = path.join(ROOT, (pkg.build.directories && pkg.build.directories.output) || 'dist');

function fail(msg) {
    console.error(`\nLOI: ${msg}\n`);
    process.exit(1);
}

if (!owner || !repo) fail('package.json thieu build.publish[0].owner / repo.');
if (!token) fail('Chua co GH_TOKEN.');
if (typeof fetch !== 'function') fail('Can Node.js 18 tro len. Hay cai Node.js LTS moi.');

const api = `https://api.github.com/repos/${owner}/${repo}`;
const baseHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'lan-print-build'
};

async function gh(method, url, body, extraHeaders = {}) {
    const isJson = body !== undefined && !Buffer.isBuffer(body);
    const res = await fetch(url, {
        method,
        headers: {
            ...baseHeaders,
            ...(isJson ? { 'Content-Type': 'application/json' } : {}),
            ...extraHeaders
        },
        body: body === undefined ? undefined : (isJson ? JSON.stringify(body) : body)
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* body rỗng */ }
    return { status: res.status, data };
}

const short = (data) => JSON.stringify(data && (data.errors || data.message) || data);

// ---------------------------------------------------------------- repo / tag
async function checkRepo() {
    const res = await gh('GET', api);
    if (res.status === 401) fail('GH_TOKEN khong hop le hoac da het han.');
    if (res.status === 404) fail(`Khong tim thay repo ${owner}/${repo} (sai ten, hoac token khong duoc cap quyen repo nay).`);
    if (res.status !== 200) fail(`Khong doc duoc repo: HTTP ${res.status} ${short(res.data)}`);
    if (res.data.permissions && res.data.permissions.push === false) {
        fail('GH_TOKEN khong co quyen ghi (Contents: Read and write) vao repo nay.');
    }
    if (res.data.archived) fail('Repo dang Archived - hay Unarchive trong Settings cua repo.');
    return res.data.default_branch || 'main';
}

async function createFirstCommit(branch) {
    console.log('Repo dang TRONG (chua co commit) -> tao commit dau tien (README.md)...');
    const readme = `# ${pkg.build.productName || pkg.name}\n\n${pkg.description || ''}\n\nBan cai dat: xem muc Releases.\n`;
    const res = await gh('PUT', `${api}/contents/README.md`, {
        message: 'Initial commit',
        content: Buffer.from(readme, 'utf8').toString('base64'),
        branch
    });
    if (res.status !== 201 && res.status !== 200) fail(`Khong tao duoc commit dau tien: HTTP ${res.status} ${short(res.data)}`);
    return res.data.commit.sha;
}

async function getTargetCommitSha(branch) {
    const ref = await gh('GET', `${api}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (ref.status === 200 && ref.data && ref.data.object) return ref.data.object.sha;
    const commits = await gh('GET', `${api}/commits?per_page=1`);
    if (commits.status === 409) return createFirstCommit(branch);
    if (commits.status === 200 && Array.isArray(commits.data) && commits.data.length) return commits.data[0].sha;
    return createFirstCommit(branch);
}

async function ensureTag(branch) {
    const existing = await gh('GET', `${api}/git/ref/tags/${encodeURIComponent(tag)}`);
    if (existing.status === 200) return;
    const sha = await getTargetCommitSha(branch);
    const res = await gh('POST', `${api}/git/refs`, { ref: `refs/tags/${tag}`, sha });
    if (res.status === 201) {
        console.log(`Da tao tag ${tag} -> commit ${sha.slice(0, 7)}.`);
        return;
    }
    const detail = short(res.data);
    if (res.status === 422 && /already exists/i.test(detail)) return;
    if (res.status === 422 && /rule|protect|violat/i.test(detail)) {
        fail(`GitHub chan tao tag ${tag} do Ruleset/Tag protection.\n` +
            `   Vao https://github.com/${owner}/${repo}/settings/rules tat hoac them ngoai le cho tag "v*".\n   Chi tiet: ${detail}`);
    }
    fail(`Khong tao duoc tag ${tag}: HTTP ${res.status} ${detail}`);
}

// ---------------------------------------------------------------- release
// Tìm release theo tag, KỂ CẢ bản nháp (API /releases/tags/ không trả về draft).
async function findReleaseByTag() {
    for (let page = 1; page <= 10; page++) {
        const res = await gh('GET', `${api}/releases?per_page=100&page=${page}`);
        if (res.status !== 200) fail(`Khong doc duoc danh sach release: HTTP ${res.status} ${short(res.data)}`);
        const found = res.data.find(r => r.tag_name === tag);
        if (found) return found;
        if (res.data.length < 100) return null;
    }
    return null;
}

function isAlreadyPublishedWithInstaller(release) {
    return release && !release.draft && (release.assets || []).some(a => /\.exe$/i.test(a.name));
}

async function getOrCreateDraftRelease() {
    const existing = await findReleaseByTag();
    if (existing) {
        console.log(`Dung lai release ${tag} da co (${existing.draft ? 'ban nhap' : 'da publish nhung chua co file cai dat'}).`);
        return existing;
    }
    const res = await gh('POST', `${api}/releases`, {
        tag_name: tag,
        name: tag,
        body: `${pkg.build.productName || pkg.name} ${tag}`,
        draft: true,
        prerelease: false
    });
    if (res.status !== 201) fail(`Khong tao duoc release ${tag}: HTTP ${res.status} ${short(res.data)}`);
    console.log(`Da tao release nhap ${tag}.`);
    return res.data;
}

function collectBuildFiles() {
    if (!fs.existsSync(outDir)) fail(`Khong thay thu muc build: ${outDir}. Hay build truoc.`);
    const names = fs.readdirSync(outDir).filter(name => {
        if (name === 'latest.yml') return true;
        return name.includes(version) && /\.(exe|exe\.blockmap)$/i.test(name);
    });
    if (!names.some(n => /\.exe$/i.test(n))) fail(`Khong thay file cai dat .exe cua ${tag} trong ${outDir}.`);
    if (!names.includes('latest.yml')) {
        fail(`Khong thay ${path.join(outDir, 'latest.yml')} - thieu file nay Auto Update tren may nguoi dung se khong hoat dong.`);
    }
    const latest = fs.readFileSync(path.join(outDir, 'latest.yml'), 'utf8');
    if (!new RegExp(`^version:\\s*${version.replace(/\./g, '\\.')}\\s*$`, 'm').test(latest)) {
        fail(`latest.yml trong ${outDir} khong phai cua ${version} (file cu). Hay xoa thu muc dist roi build lai.`);
    }
    return names;
}

async function uploadAsset(release, fileName) {
    // Xoá file cũ cùng tên (lần upload trước bị lỗi giữa chừng) để upload lại.
    const old = (release.assets || []).find(a => a.name === fileName);
    if (old) {
        const del = await gh('DELETE', `${api}/releases/assets/${old.id}`);
        if (del.status !== 204) fail(`Khong xoa duoc file cu ${fileName}: HTTP ${del.status} ${short(del.data)}`);
    }
    const buffer = fs.readFileSync(path.join(outDir, fileName));
    const sizeMb = (buffer.length / 1024 / 1024).toFixed(1);
    process.stdout.write(`  Dang upload ${fileName} (${sizeMb} MB)... `);
    const uploadUrl = `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(fileName)}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await gh('POST', uploadUrl, buffer, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(buffer.length)
            });
            if (res.status === 201) { console.log('OK'); return; }
            if (attempt === 3) fail(`Upload ${fileName} that bai: HTTP ${res.status} ${short(res.data)}`);
        } catch (err) {
            if (attempt === 3) fail(`Upload ${fileName} that bai: ${err.message}`);
        }
        process.stdout.write(`thu lai (${attempt + 1}/3)... `);
        await new Promise(r => setTimeout(r, 3000));
    }
}

// ---------------------------------------------------------------- main
(async () => {
    const branch = await checkRepo();
    console.log(`Repo: ${owner}/${repo} | nhanh: ${branch} | tag: ${tag}`);

    const existing = await findReleaseByTag();
    if (isAlreadyPublishedWithInstaller(existing)) {
        fail(`Release ${tag} da publish va da co file cai dat. Hay tang "version" trong package.json roi build lai.`);
    }
    if (CHECK_ONLY) {
        await ensureTag(branch);
        console.log('Kiem tra GitHub: OK.');
        return;
    }

    const files = collectBuildFiles();
    await ensureTag(branch);
    const release = await getOrCreateDraftRelease();

    console.log(`Upload ${files.length} file len release ${tag}:`);
    // latest.yml upload CUỐI CÙNG: máy người dùng chỉ thấy bản mới khi file cài đặt đã lên đủ.
    files.sort((a, b) => (a === 'latest.yml') - (b === 'latest.yml'));
    for (const name of files) await uploadAsset(release, name);

    const pub = await gh('PATCH', `${api}/releases/${release.id}`, {
        tag_name: tag,
        name: tag,
        draft: false,
        prerelease: false,
        make_latest: 'true'
    });
    if (pub.status !== 200) fail(`Khong publish duoc release: HTTP ${pub.status} ${short(pub.data)}`);
    console.log(`\nDa publish: ${pub.data.html_url}`);
})().catch(err => fail(`Loi ket noi GitHub: ${err.message}`));
