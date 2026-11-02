-- M10 step 22 (RT-08): the provider's summary of an answer's reasoning, where it sends one,
-- shown under the answer's "Thought for" line. NULL where the provider keeps it hidden.
ALTER TABLE messages ADD COLUMN reasoning_summary TEXT;
