-- ============================================================
-- 鸡西大学校园电脑维修 - 阶段 2：数据库初始化
-- 在 Supabase 后台 SQL Editor 中整段粘贴运行（可重复运行，不会报错）
--
-- 设计原则：
--   1. 前端（浏览器）永远不直接访问数据库，所有读写都经过 Netlify Functions。
--   2. 所有表开启行级安全（RLS）且不创建任何放行策略 = 浏览器端完全无权访问。
--   3. 取消链接 Token 的原文不入库，只保存 SHA-256 哈希。
--   4. 图片放在私有存储桶，不能公开访问。
-- ============================================================

-- ---------- 订单编号序列 ----------
create sequence if not exists public.order_no_seq start 1;

-- ---------- 订单表 ----------
create table if not exists public.orders (
  id               uuid primary key default gen_random_uuid(),
  order_no         text not null unique
                   default ('JX' || to_char(now() at time zone 'Asia/Shanghai', 'YYMMDD')
                            || '-' || lpad(nextval('public.order_no_seq')::text, 4, '0')),

  -- 学生填写的信息
  student_name     text not null check (char_length(student_name) between 1 and 30),
  phone            text not null check (phone ~ '^1[3-9][0-9]{9}$'),
  building         text not null check (char_length(building) between 1 and 30),
  room             text not null check (char_length(room) between 1 and 20),
  description      text not null check (char_length(description) between 5 and 1000),

  -- 状态：待处理/已接单/维修中/已完成/已取消/已拒绝
  status           text not null default 'pending'
                   check (status in ('pending','accepted','repairing','completed','cancelled','rejected')),

  -- 取消链接：只存哈希（SHA-256 的 64 位十六进制），原文只出现在学生拿到的链接里
  cancel_token_hash text not null unique check (cancel_token_hash ~ '^[0-9a-f]{64}$'),

  -- 管理员填写的信息
  quoted_price     numeric(10,2) check (quoted_price is null or quoted_price >= 0),
  final_price      numeric(10,2) check (final_price  is null or final_price  >= 0),
  reject_reason    text check (reject_reason is null or char_length(reject_reason) <= 500),
  admin_note       text check (admin_note    is null or char_length(admin_note)    <= 1000),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  cancelled_at     timestamptz
);

create index if not exists orders_status_created_idx on public.orders (status, created_at desc);

-- 每次修改订单自动更新 updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- ---------- 订单图片表（只记录私有存储桶里的文件路径） ----------
create table if not exists public.order_images (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  storage_path  text not null unique check (char_length(storage_path) between 1 and 300),
  content_type  text not null check (content_type in ('image/jpeg','image/png','image/webp')),
  size_bytes    integer not null check (size_bytes > 0 and size_bytes <= 5242880),  -- 最大 5MB
  created_at    timestamptz not null default now()
);

create index if not exists order_images_order_idx on public.order_images (order_id);

-- ---------- 订单状态变更日志 ----------
create table if not exists public.order_events (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders(id) on delete cascade,
  from_status text,
  to_status   text not null,
  actor       text not null check (actor in ('student','admin')),
  note        text check (note is null or char_length(note) <= 500),
  created_at  timestamptz not null default now()
);

create index if not exists order_events_order_idx on public.order_events (order_id, created_at);

-- ---------- 权限锁定：开启 RLS，且不创建任何策略 ----------
alter table public.orders       enable row level security;
alter table public.order_images enable row level security;
alter table public.order_events enable row level security;

-- 双保险：直接收回浏览器端角色（anon / authenticated）的所有权限
revoke all on public.orders       from anon, authenticated;
revoke all on public.order_images from anon, authenticated;
revoke all on public.order_events from anon, authenticated;
revoke all on sequence public.order_no_seq from anon, authenticated;
revoke all on sequence public.order_events_id_seq from anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- ---------- 私有图片存储桶 ----------
-- public = false：不能通过公开网址访问
-- 单文件最大 5MB，只允许 jpeg / png / webp
-- 不创建 storage.objects 的任何策略 = 浏览器端不能直接上传、列出或下载
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('repair-images', 'repair-images', false, 5242880,
        array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg','image/png','image/webp'];
