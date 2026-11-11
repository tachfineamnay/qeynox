BEGIN;
CREATE TABLE result_documents(id text PRIMARY KEY,workspace_id text NOT NULL,operation_id text NOT NULL,revision_id text NOT NULL,version integer NOT NULL,state text NOT NULL,document jsonb NOT NULL,created_at text NOT NULL,supersedes_id text);
CREATE UNIQUE INDEX result_doc_operation_version ON result_documents(operation_id,version);
CREATE TABLE artifact_objects(id text PRIMARY KEY,document_id text NOT NULL,workspace_id text NOT NULL,operation_id text NOT NULL,key text NOT NULL UNIQUE,sha256 text NOT NULL,content_type text NOT NULL,size integer NOT NULL,state text NOT NULL,version_id text,created_at text NOT NULL);
COMMIT;
