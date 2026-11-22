// 健康检查：用来确认 Netlify Functions 部署成功。
// 访问地址：/api/health
// 注意：这里不返回任何密钥或环境变量的值，只返回“是否已配置”。

export default async () => {
  const body = {
    ok: true,
    service: "jixi-campus-repair",
    time: new Date().toISOString(),
    // 只报告是否配置，绝不输出内容
    supabaseConfigured: Boolean(
      process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ),
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};

export const config = { path: "/api/health" };
