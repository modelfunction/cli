const SKILLS = [
  "python",
  "java",
  "javascript",
  "typescript",
  "react",
  "vue",
  "node",
  "go",
  "sql",
  "mysql",
  "postgresql",
  "redis",
  "docker",
  "kubernetes",
  "aws",
  "azure",
  "gcp",
  "llm",
  "rag",
  "agent",
  "mcp",
  "prompt",
  "机器学习",
  "深度学习",
  "数据分析",
  "算法",
  "前端",
  "后端",
  "产品经理",
  "项目管理",
  "运营",
  "销售",
  "面试",
  "hr",
  "人力资源管理"
];

function hasSkill(text, skill) {
  if (/^[a-z0-9 ]+$/i.test(skill)) {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
  }
  return text.includes(skill);
}

export function scoreResume({ resume, jd }) {
  if (typeof resume !== "string" || resume.trim().length < 20) {
    throw new Error("resume must be a string with at least 20 characters");
  }
  if (typeof jd !== "string" || jd.trim().length < 20) {
    throw new Error("jd must be a string with at least 20 characters");
  }

  const resumeLower = resume.toLowerCase();
  const jdLower = jd.toLowerCase();
  const jdSkills = SKILLS.filter((skill) => hasSkill(jdLower, skill));
  const matched = jdSkills.filter((skill) => hasSkill(resumeLower, skill));
  const missing = jdSkills.filter((skill) => !matched.includes(skill));
  const ratio = jdSkills.length ? matched.length / jdSkills.length : 0;
  const yearsMatch = resume.match(/(\d+)\s*(?:年|years?|yrs?)/i);
  const years = yearsMatch ? Number(yearsMatch[1]) : 0;

  let score = 45 + ratio * 45;
  if (years >= 3) score += 8;
  else if (years >= 1) score += 4;
  if (resume.length > 800) score += 2;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const reasons = [
    jdSkills.length
      ? `匹配 ${matched.length}/${jdSkills.length} 个 JD 关键词${matched.length ? "：" + matched.slice(0, 4).join("、") : ""}`
      : "JD 中没有识别到标准技能关键词",
    years ? `简历中出现 ${years} 年经验描述` : "未识别到明确年限",
    missing.length ? `缺少：${missing.slice(0, 3).join("、")}` : "覆盖了 JD 的主要关键词"
  ];

  return {
    score,
    reasons,
    matched,
    missing,
    years,
    usage: {
      input_chars: resume.length + jd.length,
      output_chars: reasons.join("").length
    }
  };
}
