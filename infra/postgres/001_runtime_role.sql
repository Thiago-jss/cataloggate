\getenv app_password POSTGRES_APP_PASSWORD
CREATE ROLE cataloggate_app LOGIN PASSWORD :'app_password';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
