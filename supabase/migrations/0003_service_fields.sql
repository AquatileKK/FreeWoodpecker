-- ============================================================
-- 阶段 5.1：订单增加“维修方式”和“预约时间”
--
-- service_mode（维修方式）：
--   visit_room    = 师傅上门到寝室（仅限男生宿舍）
--   lobby_handoff = 学生把电脑送到宿舍一楼，师傅到了电话联系，取走修好后归还（女生宿舍必须选这个）
-- preferred_time（预约时间）：学生填写的希望上门/到一楼的时间，自由文字，最多 50 字
--
-- 说明：
--   - 旧订单（测试数据）没有预约时间，所以 preferred_time 允许为空；新订单由接口保证必填。
--   - 旧订单的维修方式默认为 lobby_handoff（更保守的方式）。
--   - 表级权限已在 0002 授予，新增的列自动适用，无需再授权。浏览器端角色依然没有任何权限。
-- 可重复运行。
-- ============================================================

alter table public.orders
  add column if not exists service_mode text not null default 'lobby_handoff'
    check (service_mode in ('visit_room', 'lobby_handoff'));

alter table public.orders
  add column if not exists preferred_time text
    check (preferred_time is null or char_length(preferred_time) between 1 and 50);
