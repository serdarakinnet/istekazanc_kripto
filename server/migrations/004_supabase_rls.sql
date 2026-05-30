DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.users ENABLE ROW LEVEL SECURITY';
EXCEPTION WHEN others THEN
END $$;

DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY';
EXCEPTION WHEN others THEN
END $$;

DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY';
EXCEPTION WHEN others THEN
END $$;

DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.trade_reports ENABLE ROW LEVEL SECURITY';
EXCEPTION WHEN others THEN
END $$;

DO $$
BEGIN
  EXECUTE 'CREATE POLICY users_select_own ON public.users FOR SELECT TO authenticated USING (id = auth.uid())';
EXCEPTION WHEN duplicate_object THEN
END $$;

DO $$
BEGIN
  EXECUTE 'CREATE POLICY users_insert_own ON public.users FOR INSERT TO authenticated WITH CHECK (id = auth.uid())';
EXCEPTION WHEN duplicate_object THEN
END $$;

DO $$
BEGIN
  EXECUTE 'CREATE POLICY users_update_own ON public.users FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid())';
EXCEPTION WHEN duplicate_object THEN
END $$;

DO $$
BEGIN
  EXECUTE 'CREATE POLICY settings_select_own ON public.user_settings FOR SELECT TO authenticated USING (user_id = auth.uid())';
EXCEPTION WHEN duplicate_object THEN
END $$;

DO $$
BEGIN
  EXECUTE 'CREATE POLICY settings_insert_own ON public.user_settings FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid())';
EXCEPTION WHEN duplicate_object THEN
END $$;

DO $$
BEGIN
  EXECUTE 'CREATE POLICY settings_update_own ON public.user_settings FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())';
EXCEPTION WHEN duplicate_object THEN
END $$;

DO $$
BEGIN
  EXECUTE 'CREATE POLICY positions_select_own ON public.positions FOR SELECT TO authenticated USING (user_id = auth.uid())';
EXCEPTION WHEN duplicate_object THEN
END $$;

DO $$
BEGIN
  EXECUTE 'CREATE POLICY positions_insert_own ON public.positions FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid())';
EXCEPTION WHEN duplicate_object THEN
END $$;

DO $$
BEGIN
  EXECUTE 'CREATE POLICY positions_update_own ON public.positions FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())';
EXCEPTION WHEN duplicate_object THEN
END $$;

DO $$
BEGIN
  EXECUTE 'CREATE POLICY positions_delete_own ON public.positions FOR DELETE TO authenticated USING (user_id = auth.uid())';
EXCEPTION WHEN duplicate_object THEN
END $$;

DO $$
BEGIN
  EXECUTE 'CREATE POLICY reports_select_own ON public.trade_reports FOR SELECT TO authenticated USING (user_id = auth.uid())';
EXCEPTION WHEN duplicate_object THEN
END $$;

DO $$
BEGIN
  EXECUTE 'CREATE POLICY reports_insert_own ON public.trade_reports FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid())';
EXCEPTION WHEN duplicate_object THEN
END $$;

DO $$
BEGIN
  EXECUTE 'CREATE POLICY reports_update_own ON public.trade_reports FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())';
EXCEPTION WHEN duplicate_object THEN
END $$;

DO $$
BEGIN
  EXECUTE 'CREATE POLICY reports_delete_own ON public.trade_reports FOR DELETE TO authenticated USING (user_id = auth.uid())';
EXCEPTION WHEN duplicate_object THEN
END $$;

