// Chuẩn bị repo GitHub TRƯỚC khi electron-builder publish.
//
// Lỗi "422 Published releases must have a valid tag" nghĩa là GitHub không
// tự tạo được tag vX.Y.Z khi tạo release. Nguyên nhân thường gặp:
//   1. Repo trống (chưa có commit) -> không có commit để gắn tag.
//   2. Nhánh mặc định không tồn tại / repo chỉ có commit ở nhánh khác.
//   3. Ruleset / Tag protection của repo chặn tạo tag "v*".
// Script này tự xử lý (1)(2) và TỰ TẠO TAG trước qua Git API, để electron-
// builder chỉ việc gắn release vào tag đã có sẵn. Nếu vẫn bị chặn (3) thì
// báo đúng lý do thay vì lỗi 422 khó hiểu.
//
// Cần Node.js 18+ (có sẵn fetch). Dùng biến môi trường GH_TOKEN.

const pkg = require('../package.json');

const publish = pkg.build && pkg.build.publish && pkg.build.publish[0];
const owner = publish && publish.owner;
const repo = publish && publish.repo;
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const tag = `v${pkg.version}`;

function fail(msg) {
    console.error(`\nLOI: ${msg}\n`);
    process.exit(1);
}

if (!owner || !repo) fail('package.json thieu build.publish[0].owner / repo.');
if (!token) fail('Chua co GH_TOKEN.');
if (typeof fetch !== 'function') fail('Can Node.js 18 tro len (khong co fetch). Hay cai Node.js LTS moi.');

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

const short = (data) => JSON.stringify(data && (data.errors || data.message) || data);

async function createFirstCommit(branch) {
    console.log(`Repo ${owner}/${repo} dang TRONG (chua co commit) -> tao commit dau tien (README.md)...`);
    const readme = `# ${pkg.build.productName || pkg.name}\n\n${pkg.description || ''}\n\nBan cai dat: xem muc Releases.\n`;
    const res = await gh('PUT', `${api}/contents/README.md`, {
        message: 'Initial commit',
        content: Buffer.from(readme, 'utf8').toString('base64'),
        branch
    });
    if (res.status !== 201 && res.status !== 200) {
        fail(`Khong tao duoc commit dau tien: HTTP ${res.status} ${short(res.data)}`);
    }
    return res.data.commit.sha;
}

// Lấy SHA commit mới nhất để gắn tag vào.
async function getTargetCommitSha(branch) {
    const refRes = await gh('GET', `${api}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (refRes.status === 200 && refRes.data && refRes.data.object) return refRes.data.object.sha;

    // Nhánh mặc định không tồn tại -> thử lấy commit mới nhất bất kỳ.
    const commitsRes = await gh('GET', `${api}/commits?per_page=1`);
    if (commitsRes.status === 409) return createFirstCommit(branch); // repo trống
    if (commitsRes.status === 200 && Array.isArray(commitsRes.data) && commitsRes.data.length) {
        console.log(`Canh bao: khong thay nhanh "${branch}", gan tag vao commit moi nhat ${commitsRes.data[0].sha.slice(0, 7)}.`);
        return commitsRes.data[0].sha;
    }
    if (refRes.status === 409 || commitsRes.status === 404) return createFirstCommit(branch);
    fail(`Khong tim duoc commit de gan tag: HTTP ${commitsRes.status} ${short(commitsRes.data)}`);
}

(async () => {
    // 1. Repo có tồn tại & token có quyền ghi không?
    const repoRes = await gh('GET', api);
    if (repoRes.status === 401) fail('GH_TOKEN khong hop le hoac da het han.');
    if (repoRes.status === 404) {
        fail(`Khong tim thay repo ${owner}/${repo} (sai ten, hoac token khong duoc cap quyen truy cap repo nay).`);
    }
    if (repoRes.status !== 200) fail(`Khong doc duoc repo: HTTP ${repoRes.status} ${short(repoRes.data)}`);
    const perms = repoRes.data.permissions || {};
    if (perms.push === false) fail('GH_TOKEN khong co quyen ghi (Contents: Read and write) vao repo nay.');
    if (repoRes.data.archived) fail('Repo dang o trang thai Archived - hay Unarchive trong Settings cua repo.');
    const branch = repoRes.data.default_branch || 'main';
    console.log(`Repo: ${owner}/${repo} | nhanh mac dinh: ${branch} | tag: ${tag}`);

    // 2. Release đã publish rồi -> quên tăng version.
    const relRes = await gh('GET', `${api}/releases/tags/${tag}`);
    if (relRes.status === 200 && relRes.data && !relRes.data.draft) {
        fail(`Release ${tag} da ton tai va da publish. Hay tang "version" trong package.json roi build lai.`);
    }

    // 3. Tag đã có chưa? Chưa có thì tự tạo.
    const tagRes = await gh('GET', `${api}/git/ref/tags/${encodeURIComponent(tag)}`);
    if (tagRes.status === 200) {
        console.log(`Tag ${tag} da ton tai -> OK.`);
    } else {
        const sha = await getTargetCommitSha(branch);
        const createRes = await gh('POST', `${api}/git/refs`, { ref: `refs/tags/${tag}`, sha });
        if (createRes.status !== 201) {
            const detail = short(createRes.data);
            if (createRes.status === 422 && /rule|protect|violat/i.test(detail)) {
                fail(`GitHub chan tao tag ${tag} do Ruleset/Tag protection cua repo.\n` +
                    `   Vao https://github.com/${owner}/${repo}/settings/rules (va Settings > Tags) ` +
                    `tat hoac them ngoai le cho tag "v*".\n   Chi tiet: ${detail}`);
            }
            fail(`Khong tao duoc tag ${tag}: HTTP ${createRes.status} ${detail}`);
        }
        console.log(`Da tao tag ${tag} -> commit ${sha.slice(0, 7)}.`);
    }

    console.log('Kiem tra GitHub: OK.');
})().catch(err => fail(`Loi ket noi GitHub: ${err.message}`));
