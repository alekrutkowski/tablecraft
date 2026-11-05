import {OPERATIONS} from '../js/catalog.js';
import {compilePipeline, defaultsFor} from '../js/compiler.js';

export const ASSERTION_FIXTURE_R = `
assertion_fixture <- data.table(
  id = 1:4,
  value = as.numeric(1:4),
  upper = as.numeric(2:5),
  category = c("A", "B", "A", "B"),
  group = c("first", "first", "second", "second"),
  flag = c(TRUE, FALSE, TRUE, FALSE),
  factor = factor(c("A", "B", "A", "B")),
  date = as.IDate("2026-01-01") + 0:3,
  probability = c(0.1, 0.2, 0.3, 0.4)
)
`;

const columns = [
  {name:'id',type:'integer'}, {name:'value',type:'numeric'}, {name:'upper',type:'numeric'},
  {name:'category',type:'character'}, {name:'group',type:'character'}, {name:'flag',type:'logical'},
  {name:'factor',type:'factor'}, {name:'date',type:'IDate'}, {name:'probability',type:'numeric'},
];
const allColumns = columns.map(column => column.name).join(', ');
// Passing and failing configurations exercise every template, including the
// existence guards. Wrong data types and programming errors are not accepted as
// expected assertion failures by the integration harness.
const configurations = {
  assert:[{condition:'nrow(.) == 4L'}, {condition:'nrow(.) == 99L'}],
  'assert-nonempty':[{}, {}, null, 'assertion_fixture[0]'],
  'assert-empty':[{}, {}, 'assertion_fixture[0]'],
  'assert-rows-exact':[{n:4}, {n:5}],
  'assert-rows-min':[{n:1}, {n:99}],
  'assert-rows-max':[{n:100}, {n:0}],
  'assert-rows-range':[{min:0,max:10}, {min:10,max:20}],
  'assert-all-rows':[{condition:'value > 0'}, {condition:'value < 0'}],
  'assert-some-rows':[{condition:'value == 1'}, {condition:'value > 100'}],
  'assert-no-rows':[{condition:'value < 0'}, {condition:'value > 0'}],
  'assert-columns-exist':[{columns:'id, value'}, {columns:'missing'}],
  'assert-columns-exact':[{columns:allColumns}, {columns:'id, value'}],
  'assert-column-order':[{columns:allColumns}, {columns:columns.map(column => column.name).reverse().join(', ')}],
  'assert-column-count':[{n:9}, {n:999}],
  'assert-column-names-unique':[{}, {}, null, 'setnames(copy(assertion_fixture), rep("duplicate", 9L))'],
  'assert-column-names-nonblank':[{}, {}, null, 'setnames(copy(assertion_fixture), c(" ", names(assertion_fixture)[-1L]))'],
  'assert-unique-rows':[{}, {}, null, 'rbind(assertion_fixture, assertion_fixture)'],
  'assert-unique-key':[{columns:'id'}, {columns:'group'}],
  'assert-primary-key':[{columns:'id'}, {columns:'id'}, null, 'copy(assertion_fixture)[1L, id := NA_integer_]'],
  'assert-unique-column':[{column:'id'}, {column:'group'}],
  'assert-unique-in-groups':[{columns:'value',groups:'group'}, {columns:'value',groups:'group'}, null, 'copy(assertion_fixture)[, value := 1]'],
  'assert-no-missing':[{}, {}, null, 'copy(assertion_fixture)[1L, value := NA_real_]'],
  'assert-columns-complete':[{columns:'value'}, {columns:'value'}, null, 'copy(assertion_fixture)[1L, value := NA_real_]'],
  'assert-column-complete':[{column:'value'}, {column:'value'}, null, 'copy(assertion_fixture)[1L, value := NA_real_]'],
  'assert-missing-rate':[{columns:'value',maximum:0.1}, {columns:'value',maximum:0.1}, null, 'copy(assertion_fixture)[1L, value := NA_real_]'],
  'assert-not-all-missing':[{columns:'value'}, {columns:'value'}, null, 'copy(assertion_fixture)[, value := NA_real_]'],
  'assert-numeric-columns':[{columns:'value'}, {columns:'category'}],
  'assert-integer-columns':[{columns:'id'}, {columns:'value'}],
  'assert-character-columns':[{columns:'category'}, {columns:'value'}],
  'assert-logical-columns':[{columns:'flag'}, {columns:'value'}],
  'assert-factor-columns':[{columns:'factor'}, {columns:'category'}],
  'assert-date-columns':[{columns:'date'}, {columns:'id'}],
  'assert-finite':[{column:'value'}, {column:'value'}, null, 'copy(assertion_fixture)[1L, value := Inf]'],
  'assert-nonnegative':[{column:'value'}, {column:'value'}, null, 'copy(assertion_fixture)[1L, value := -1]'],
  'assert-positive':[{column:'value'}, {column:'value'}, null, 'copy(assertion_fixture)[1L, value := 0]'],
  'assert-bounds':[{column:'value',lower:'0',upper:'10'}, {column:'value',lower:'0',upper:'2'}],
  'assert-integer-values':[{column:'value'}, {column:'value'}, null, 'copy(assertion_fixture)[1L, value := 1.5]'],
  'assert-probability':[{column:'probability'}, {column:'value'}],
  'assert-allowed-values':[{column:'category',values:'c("A", "B")'}, {column:'category',values:'"A"'}],
  'assert-text-nonblank':[{column:'category'}, {column:'category'}, null, 'copy(assertion_fixture)[1L, category := " "]'],
  'assert-text-trimmed':[{column:'category'}, {column:'category'}, null, 'copy(assertion_fixture)[1L, category := " A "]'],
  'assert-text-pattern':[{column:'category',pattern:'^[AB]$'}, {column:'category',pattern:'^Z$'}],
  'assert-sorted':[{column:'id'}, {column:'id'}, null, 'assertion_fixture[4:1]'],
  'assert-strictly-increasing':[{column:'id'}, {column:'id'}, null, 'copy(assertion_fixture)[2L, id := 1L]'],
  'assert-column-equality':[{column:'value',otherColumn:'value'}, {column:'value',otherColumn:'upper'}],
  'assert-column-ordering':[{column:'value',otherColumn:'upper'}, {column:'upper',otherColumn:'value'}],
  'assert-column-total':[{column:'value',expected:'10'}, {column:'value',expected:'11'}],
  'assert-row-totals':[{columns:'value, upper',expected:'2 * .$value + 1'}, {columns:'value, upper',expected:'0'}],
  'assert-same-row-count':[{table:'.'}, {table:'head(., 1L)'}],
  'assert-same-column-names':[{table:'.'}, {table:'.[, "id", with = FALSE]'}],
  'assert-same-schema':[{table:'.'}, {table:'copy(.)[, value := as.character(value)]'}],
  'assert-same-data':[{table:'.'}, {table:'copy(.)[, value := value + 1]'}],
  'assert-foreign-key':[{columns:'id',table:'.'}, {columns:'id',table:'.[id < 4L]'}],
  'assert-disjoint-keys':[{columns:'id',table:'copy(.)[, id := id + 10L]'}, {columns:'id',table:'.'}],
};

export function assertionCases() {
  return OPERATIONS.filter(operation => operation.category === 'Assertions').flatMap(operation => {
    const configuration = configurations[operation.id];
    if (!configuration) throw new Error(`Missing positive/negative coverage for ${operation.id}`);
    return [false, true].map(failure => {
      const sourceCode = configuration[failure ? 3 : 2] || 'assertion_fixture';
      const params = {...defaultsFor(operation.id,columns), ...configuration[failure ? 1 : 0], message:'Assertion regression check failed.'};
      return {
        name:`${operation.id}-${failure ? 'reject' : 'pass'}`,
        code:compilePipeline({sourceCode,steps:[{id:operation.id,op:operation.id,params}]}).code,
        expectedError:failure ? 'Assertion regression check failed.|must exist' : '',
        expectedSource:failure ? '' : sourceCode,
        step:{id:operation.id,op:operation.id,params},
      };
    });
  });
}
