// Kiểm tra repo GitHub trước khi electron-builder publish.
//
// Lỗi "422 Published releases must have a valid tag" xảy ra khi repo TRỐNG
// (chưa có commit nào): GitHub không có commit để gắn tag vX.Y.Z nên từ chối
// tạo release. Script này tự tạo commit đầu tiên (README.md) nếu repo trống,
// đồng thời báo lỗi rõ ràng nếu token sai / thiếu quyền / repo không tồn tại.
//
// Cần Node.js 18+ (có sẵn fetch). Dùng biến môi trường GH_TOKEN.

const pkg = require('../package.json');

const publish = pkg.build && pkg.build.publish && pkg.build.publish[0];
const owner = publish && publish.owner;
const repo = publish && publish.repo;
const token = process.env.GH_TOKEN;
const tag = `v${pkg.version}`;

function fail(msg) {
    console.error(`LOI: ${msg}`);
    process.exit(1);
}

if (!owner || !repo) fail('package.json thieu build.publish[0].owner / repo.');
if (!token) fail('Chua co GH_TOKEN.');
if (typeof fetch !== 'function') fail('Can Node.js 18 tro len (khong co fetch).');

const api = `https://api.github.com/repos/${owner}/${repo}`;
const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'lan-print-build'
};

async function gh(method, url, body) {
    const res = await fetch(url, {
        method,
        headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
        body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* body rỗng */ }
    return { status: res.status, data };
}

(async () => {
    // 1. Repo có tồn tại & token có quyền ghi không?
    const repoRes = await gh('GET', api);
    if (repoRes.status === 401) fail('GH_TOKEN khong hop le hoac da het han.');
    if (repoRes.status === 404) {
        fail(`Khong tim thay repo ${owner}/${repo} (sai ten, hoac token khong duoc cap quyen truy cap repo nay).`);
    }
    if (repoRes.status !== 200) fail(`Khong doc duoc repo: HTTP ${repoRes.status} ${JSON.stringify(repoRes.data)}`);

    const perms = repoRes.data.permissions || {};
    if (perms.push === false) {
        fail('GH_TOKEN khong co quyen ghi (Contents: Read and write) vao repo nay.');
    }
    const branch = repoRes.data.default_branch || 'main';

    // 2. Repo trống? GitHub trả 409 "Git Repository is empty" khi chưa có commit.
    const commitsRes = await gh('GET', `${api}/commits?per_page=1`);
    if (commitsRes.status === 409) {
        console.log(`Repo ${owner}/${repo} dang trong (chua co commit) -> tao commit dau tien (README.md)...`);
        const readme = `# ${pkg.build.productName || pkg.name}\n\n${pkg.description || ''}\n\nBan cai dat: xem muc Releases.\n`;
        const createRes = await gh('PUT', `${api}/contents/README.md`, {
            message: 'Initial commit',
            content: Buffer.from(readme, 'utf8').toString('base64'),
            branch
        });
        if (createRes.status !== 201 && createRes.status !== 200) {
            fail(`Khong tao duoc commit dau tien: HTTP ${createRes.status} ${JSON.stringify(createRes.data)}`);
        }
        console.log('Da tao commit dau tien. Repo san sang de tao tag/release.');
    } else if (commitsRes.status !== 200) {
        fail(`Khong doc duoc commit cua repo: HTTP ${commitsRes.status} ${JSON.stringify(commitsRes.data)}`);
    } else {
        console.log(`Repo ${owner}/${repo} da co commit tren nhanh "${branch}".`);
    }

    // 3. Cảnh báo nếu tag/release đã publish rồi (quên tăng version).
    const relRes = await gh('GET', `${api}/releases/tags/${tag}`);
    if (relRes.status === 200 && relRes.data && !relRes.data.draft) {
        fail(`Release ${tag} da ton tai va da publish. Hay tang "version" trong package.json roi build lai.`);
    }

    console.log('Kiem tra GitHub: OK.');
})().catch(err => fail(`Loi ket noi GitHub: ${err.message}`));
