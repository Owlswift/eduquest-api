-- Registration used to store the state lowercased ("lagos") while the profile
-- update stored it as typed ("Lagos"), so state rankings, which match on exact
-- text, split one state into two groups. Rewrite every recognisable value to
-- the canonical spelling (see src/common/geo/nigerian-states.ts). Values that
-- are not recognisably a Nigerian state are left untouched.
UPDATE "User" u
   SET "state" = m.name
  FROM (VALUES
    ('Abia', 'abia'),
    ('Adamawa', 'adamawa'),
    ('Akwa Ibom', 'akwaibom'),
    ('Anambra', 'anambra'),
    ('Bauchi', 'bauchi'),
    ('Bayelsa', 'bayelsa'),
    ('Benue', 'benue'),
    ('Borno', 'borno'),
    ('Cross River', 'crossriver'),
    ('Delta', 'delta'),
    ('Ebonyi', 'ebonyi'),
    ('Edo', 'edo'),
    ('Ekiti', 'ekiti'),
    ('Enugu', 'enugu'),
    ('FCT', 'fct'),
    ('Gombe', 'gombe'),
    ('Imo', 'imo'),
    ('Jigawa', 'jigawa'),
    ('Kaduna', 'kaduna'),
    ('Kano', 'kano'),
    ('Katsina', 'katsina'),
    ('Kebbi', 'kebbi'),
    ('Kogi', 'kogi'),
    ('Kwara', 'kwara'),
    ('Lagos', 'lagos'),
    ('Nasarawa', 'nasarawa'),
    ('Niger', 'niger'),
    ('Ogun', 'ogun'),
    ('Ondo', 'ondo'),
    ('Osun', 'osun'),
    ('Oyo', 'oyo'),
    ('Plateau', 'plateau'),
    ('Rivers', 'rivers'),
    ('Sokoto', 'sokoto'),
    ('Taraba', 'taraba'),
    ('Yobe', 'yobe'),
    ('Zamfara', 'zamfara'),
    ('FCT', 'abuja'),
    ('FCT', 'federalcapitalterritory'),
    ('FCT', 'fctabuja')
  ) AS m(name, k)
 WHERE u."state" IS NOT NULL
   AND (
        regexp_replace(lower(u."state"), '[^a-z]', '', 'g') = m.k
     OR regexp_replace(regexp_replace(lower(u."state"), '[^a-z]', '', 'g'), 'state$', '') = m.k
   )
   AND u."state" <> m.name;
