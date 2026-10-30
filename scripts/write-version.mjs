// বিল্ডের পর dist/version.json লেখে — কোন commit লাইভ আছে তা যাচাই করতে (CI টেস্ট এটা দেখে)
import { writeFileSync } from 'node:fs';
const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || 'local';
writeFileSync('dist/version.json', JSON.stringify({ sha, builtAt: new Date().toISOString() }));
console.log('version.json', sha);
