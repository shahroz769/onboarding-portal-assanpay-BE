DO $$
DECLARE
  v_queue_id uuid;
  v_queue_prefix text;
  v_new_stage_id uuid;
  v_next_number integer;
  v_merchant record;
BEGIN
  INSERT INTO queues (id, name, slug, prefix, qc_enabled, created_at)
  VALUES (gen_random_uuid(), 'Documents Review', 'documents-review', 'DR', false, now())
  ON CONFLICT (slug) DO UPDATE
  SET name = 'Documents Review',
      prefix = 'DR',
      qc_enabled = false
  RETURNING id, prefix INTO v_queue_id, v_queue_prefix;

  INSERT INTO queue_stages (queue_id, name, slug, "order", category, created_at)
  VALUES
    (v_queue_id, 'New', 'new', 1, 'new', now()),
    (v_queue_id, 'Working', 'working', 2, 'in_progress', now()),
    (v_queue_id, 'Awaiting Client', 'awaiting_client', 3, 'in_progress', now()),
    (v_queue_id, 'Closed', 'closed', 4, 'closed', now())
  ON CONFLICT (queue_id, slug) DO NOTHING;

  SELECT id INTO v_new_stage_id
  FROM queue_stages
  WHERE queue_id = v_queue_id
    AND slug = 'new'
  ORDER BY "order"
  LIMIT 1;

  IF v_new_stage_id IS NULL THEN
    RAISE EXCEPTION 'No new stage configured for documents-review queue.';
  END IF;

  INSERT INTO queue_case_sequences (queue_id, last_number)
  VALUES (v_queue_id, 0)
  ON CONFLICT (queue_id) DO NOTHING;

  FOR v_merchant IN
    SELECT m.id, m.priority
    FROM merchants m
    WHERE m.deleted_at IS NULL
      AND m.status IN ('form_submitted', 'documents_review')
      AND m.onboarding_stage IN ('form_submitted', 'documents_review')
      AND NOT EXISTS (
        SELECT 1
        FROM cases c
        INNER JOIN queues q ON q.id = c.queue_id
        WHERE c.merchant_id = m.id
          AND q.slug = 'documents-review'
      )
    ORDER BY m.submitted_at, m.id
  LOOP
    UPDATE queue_case_sequences
    SET last_number = last_number + 1
    WHERE queue_id = v_queue_id
    RETURNING last_number INTO v_next_number;

    INSERT INTO cases (
      case_number,
      queue_id,
      merchant_id,
      owner_id,
      current_stage_id,
      status,
      priority,
      updated_at
    )
    VALUES (
      v_queue_prefix || '-' || lpad(v_next_number::text, 9, '0'),
      v_queue_id,
      v_merchant.id,
      null,
      v_new_stage_id,
      'new',
      v_merchant.priority,
      now()
    );

    UPDATE merchants
    SET status = 'documents_review',
        onboarding_stage = 'documents_review',
        updated_at = now()
    WHERE id = v_merchant.id;
  END LOOP;
END $$;
