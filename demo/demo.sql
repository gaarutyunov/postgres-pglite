-- SQL/PGQ demo for the wasm32 PGlite build of this fork.
--
-- Hand-written on purpose: nothing here is generated, and nothing is mocked.
-- Every statement below is sent over the real Postgres wire protocol to the
-- PG19 backend running as WebAssembly inside a Web Worker, and the rows the
-- page renders are the rows the engine returned.
--
-- The point of the demo is the GRAPH_TABLE queries at the bottom: they are the
-- SQL/PGQ surface that this fork exists to provide, and they cannot run on
-- stock Postgres 18.

-- ---------------------------------------------------------------------------
-- 1. Base tables. A property graph is a view over ordinary relational tables;
--    SQL/PGQ does not introduce a separate storage engine.
-- ---------------------------------------------------------------------------

CREATE TABLE people (
    person_id integer PRIMARY KEY,
    name      varchar NOT NULL,
    city      varchar NOT NULL
);

CREATE TABLE companies (
    company_id integer PRIMARY KEY,
    name       varchar NOT NULL,
    industry   varchar NOT NULL
);

-- Edge table: person -> person.
CREATE TABLE knows (
    knows_id integer PRIMARY KEY,
    from_id  integer NOT NULL REFERENCES people (person_id),
    to_id    integer NOT NULL REFERENCES people (person_id),
    since    date    NOT NULL
);

-- Edge table: person -> company.
CREATE TABLE employment (
    employment_id integer PRIMARY KEY,
    person_id     integer NOT NULL REFERENCES people (person_id),
    company_id    integer NOT NULL REFERENCES companies (company_id),
    role          varchar NOT NULL
);

-- ---------------------------------------------------------------------------
-- 2. The property graph. VERTEX TABLES and EDGE TABLES map the relational
--    tables above onto labelled vertices and edges.
-- ---------------------------------------------------------------------------

CREATE PROPERTY GRAPH social
    VERTEX TABLES (
        people    KEY (person_id)
            LABEL person  PROPERTIES (person_id, name, city),
        companies KEY (company_id)
            LABEL company PROPERTIES (company_id, name AS company_name, industry)
    )
    EDGE TABLES (
        knows KEY (knows_id)
            SOURCE      KEY (from_id) REFERENCES people (person_id)
            DESTINATION KEY (to_id)   REFERENCES people (person_id)
            LABEL knows PROPERTIES (since),
        employment KEY (employment_id)
            SOURCE      KEY (person_id)  REFERENCES people (person_id)
            DESTINATION KEY (company_id) REFERENCES companies (company_id)
            LABEL works_at PROPERTIES (role)
    );

-- ---------------------------------------------------------------------------
-- 3. Seed rows.
-- ---------------------------------------------------------------------------

INSERT INTO people (person_id, name, city) VALUES
    (1, 'Ada',    'Berlin'),
    (2, 'Bruno',  'Berlin'),
    (3, 'Chidi',  'Lisbon'),
    (4, 'Dagny',  'Tallinn'),
    (5, 'Emeka',  'Lisbon');

INSERT INTO companies (company_id, name, industry) VALUES
    (10, 'Northwind Analytics', 'software'),
    (20, 'Baltic Freight',      'logistics'),
    (30, 'Tagus Robotics',      'hardware');

INSERT INTO knows (knows_id, from_id, to_id, since) VALUES
    (1, 1, 2, date '2019-04-02'),
    (2, 2, 3, date '2020-11-17'),
    (3, 3, 5, date '2021-06-30'),
    (4, 1, 4, date '2022-02-14'),
    (5, 4, 5, date '2023-09-01');

INSERT INTO employment (employment_id, person_id, company_id, role) VALUES
    (1, 1, 10, 'engineer'),
    (2, 2, 10, 'designer'),
    (3, 3, 30, 'engineer'),
    (4, 4, 20, 'dispatcher'),
    (5, 5, 30, 'technician');

-- ---------------------------------------------------------------------------
-- 4. The graph queries. This is the acceptance test.
-- ---------------------------------------------------------------------------

-- Q1: single-vertex pattern. Proves GRAPH_TABLE parses, plans and executes,
-- and that label/property resolution works.
SELECT * FROM GRAPH_TABLE (social
    MATCH (p IS person)
    COLUMNS (p.name, p.city)
) ORDER BY name;

-- Q2: one-hop traversal across an edge table, with a predicate on the source
-- vertex and a property projected off the edge itself.
SELECT * FROM GRAPH_TABLE (social
    MATCH (a IS person WHERE a.city = 'Berlin')-[k IS knows]->(b IS person)
    COLUMNS (a.name AS knower, b.name AS known, k.since)
) ORDER BY knower, known;

-- Q3: two-hop pattern joining across both edge tables — person knows person,
-- who works at a company. Exercises multi-element path patterns.
SELECT * FROM GRAPH_TABLE (social
    MATCH (a IS person)-[IS knows]->(b IS person)-[w IS works_at]->(c IS company)
    COLUMNS (a.name AS person, b.name AS acquaintance, c.company_name, w.role)
) ORDER BY person, acquaintance;

-- Q4: reverse edge traversal. The pattern is written right-to-left with <-[ ]-
-- to prove direction handling is real and not a textual trick.
SELECT * FROM GRAPH_TABLE (social
    MATCH (c IS company)<-[w IS works_at]-(p IS person WHERE p.city = 'Lisbon')
    COLUMNS (c.company_name, p.name AS employee, w.role)
) ORDER BY company_name, employee;

-- Q5: aggregation over a graph pattern, to show GRAPH_TABLE composes with
-- ordinary SQL rather than being a separate query language bolted on.
SELECT city, count(*) AS outgoing_edges
FROM GRAPH_TABLE (social
    MATCH (a IS person)-[IS knows]->(b IS person)
    COLUMNS (a.city AS city)
)
GROUP BY city
ORDER BY outgoing_edges DESC, city;

-- Q6: proof this is really Postgres 19 with the SQL/PGQ catalogs installed.
SELECT version();
