-- Fixed signature appended verbatim to every AI draft (links, phone, address).
-- Kept out of the model's hands so links and contact details are always exact.
alter table public.agent_settings
  add column if not exists signature text check (length(signature) <= 600);
