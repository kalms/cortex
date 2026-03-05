package smoke

import "fmt"

// DataStore holds processed data.
type DataStore struct {
	Items []string
}

// ProcessData processes input and stores results.
func ProcessData(input string) *DataStore {
	formatted := FormatOutput(input)
	ds := &DataStore{Items: []string{formatted}}
	return ds
}

// Summary returns a summary of stored items.
func (ds *DataStore) Summary() string {
	return fmt.Sprintf("items=%d", len(ds.Items))
}
