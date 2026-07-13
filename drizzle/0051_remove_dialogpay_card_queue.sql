DO $$
DECLARE
  card_case_count integer;
BEGIN
  SELECT count(*)
  INTO card_case_count
  FROM "cases" case_row
  INNER JOIN "queues" queue_row ON queue_row."id" = case_row."queue_id"
  WHERE queue_row."slug" = 'dialogpay-card';

  IF card_case_count > 0 THEN
    RAISE EXCEPTION
      'Migration 0051 aborted: DialogPay Card queue has % case(s)',
      card_case_count;
  END IF;
END $$;
--> statement-breakpoint

DELETE FROM "queues"
WHERE "slug" = 'dialogpay-card';
