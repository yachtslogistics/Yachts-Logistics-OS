-- Yacht Logistics OS — add the dedicated operational partnership model field.
-- Safe to run more than once.

alter table public.company_profile
  add column if not exists operational_partnership_model text;
