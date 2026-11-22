-- ============================================================
-- 阶段 3 补丁：给服务端角色(service_role)明确授权
--
-- 背景：新版 Supabase 不再自动把新建的表开放给各个角色，
-- 必须显式 GRANT。0001 只收回了浏览器端角色(anon/authenticated)的权限，
-- 却没有给服务端角色授权，所以 Netlify Functions 访问订单表时报
-- “permission denied (42501)”。
--
-- 原则：只授予“当前阶段确实需要”的最小权限；浏览器端角色仍然没有任何权限。
-- 可重复运行。
-- ============================================================

grant usage on schema public to service_role;

-- 订单：提交(插入)、查询、改状态(更新)、提交失败时回滚(删除)
grant select, insert, update, delete on public.orders to service_role;

-- 图片记录、状态日志：目前只需要写入和读取
grant select, insert on public.order_images to service_role;
grant select, insert on public.order_events to service_role;

-- 订单编号来自序列，插入订单时需要使用它
grant usage, select on sequence public.order_no_seq to service_role;
grant usage, select on sequence public.order_events_id_seq to service_role;

-- 再次确认：浏览器端角色没有任何权限（防止以后误授权）
revoke all on public.orders       from anon, authenticated;
revoke all on public.order_images from anon, authenticated;
revoke all on public.order_events from anon, authenticated;
revoke all on sequence public.order_no_seq        from anon, authenticated;
revoke all on sequence public.order_events_id_seq from anon, authenticated;
